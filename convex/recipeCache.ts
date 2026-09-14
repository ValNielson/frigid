/**
 * The caches that make the recipe pipeline affordable.
 *
 * Firecrawl bills per search and per page, and its own `maxAge` index still
 * charges full price for a hit, so the only cache that saves money is this one.
 * Every entry is keyed on normalized content rather than on a user, which means
 * one person's search for chicken soup warms the next person's.
 *
 * Expiry is checked on read and a stale row is overwritten in place, so the
 * tables stay bounded without a sweep job.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { foodWords as wordsIn } from "./words";
import {
  PAGE_TTL_MS,
  RECIPE_TTL_MS,
  SEARCH_TTL_MS,
  STORE_BLOCKED_TTL_MS,
  STORE_TTL_MS,
} from "./recipePolicy";

const searchResult = v.object({
  url: v.string(),
  title: v.string(),
  description: v.optional(v.string()),
});

const ingredient = v.object({
  raw: v.string(),
  item: v.string(),
  quantity: v.optional(v.string()),
});

const recipeSource = v.union(
  v.literal("jsonld"),
  v.literal("markdown"),
  v.literal("llm"),
);

// ------------------------------------------------------------------- searches

export const getSearch = internalQuery({
  args: { queryKey: v.string() },
  returns: v.union(v.null(), v.array(searchResult)),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("searchCache")
      .withIndex("by_query_key", (q) => q.eq("queryKey", args.queryKey))
      .unique();
    if (row === null || row.expiresAt <= Date.now()) return null;
    return row.results;
  },
});

export const putSearch = internalMutation({
  args: { queryKey: v.string(), results: v.array(searchResult) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const fields = {
      queryKey: args.queryKey,
      results: args.results,
      fetchedAt: now,
      expiresAt: now + SEARCH_TTL_MS,
    };
    const existing = await ctx.db
      .query("searchCache")
      .withIndex("by_query_key", (q) => q.eq("queryKey", args.queryKey))
      .unique();
    if (existing === null) await ctx.db.insert("searchCache", fields);
    else await ctx.db.patch(existing._id, fields);
    return null;
  },
});

// ---------------------------------------------------------------------- pages

export const getPage = internalQuery({
  args: { urlKey: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      url: v.string(),
      markdown: v.string(),
      title: v.optional(v.string()),
      hadJsonLd: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("firecrawlPages")
      .withIndex("by_url_key", (q) => q.eq("urlKey", args.urlKey))
      .unique();
    if (row === null || row.expiresAt <= Date.now()) return null;
    return {
      url: row.url,
      markdown: row.markdown,
      ...(row.title !== undefined ? { title: row.title } : {}),
      hadJsonLd: row.hadJsonLd,
    };
  },
});

export const putPage = internalMutation({
  args: {
    urlKey: v.string(),
    url: v.string(),
    markdown: v.string(),
    title: v.optional(v.string()),
    hadJsonLd: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const fields = { ...args, fetchedAt: now, expiresAt: now + PAGE_TTL_MS };
    const existing = await ctx.db
      .query("firecrawlPages")
      .withIndex("by_url_key", (q) => q.eq("urlKey", args.urlKey))
      .unique();
    if (existing === null) await ctx.db.insert("firecrawlPages", fields);
    else await ctx.db.patch(existing._id, fields);
    return null;
  },
});

// -------------------------------------------------------------------- recipes

const cachedRecipe = v.object({
  url: v.string(),
  domain: v.string(),
  name: v.string(),
  image: v.optional(v.string()),
  totalTimeMinutes: v.optional(v.number()),
  servings: v.optional(v.string()),
  source: recipeSource,
  ingredients: v.array(ingredient),
});

export const getRecipe = internalQuery({
  args: { urlKey: v.string() },
  returns: v.union(v.null(), cachedRecipe),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("recipeCache")
      .withIndex("by_url_key", (q) => q.eq("urlKey", args.urlKey))
      .unique();
    if (row === null || row.expiresAt <= Date.now()) return null;
    return {
      url: row.url,
      domain: row.domain,
      name: row.name,
      ...(row.image !== undefined ? { image: row.image } : {}),
      ...(row.totalTimeMinutes !== undefined
        ? { totalTimeMinutes: row.totalTimeMinutes }
        : {}),
      ...(row.servings !== undefined ? { servings: row.servings } : {}),
      source: row.source,
      ingredients: row.ingredients,
    };
  },
});

export const putRecipe = internalMutation({
  args: { urlKey: v.string(), recipe: cachedRecipe },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const fields = {
      urlKey: args.urlKey,
      ...args.recipe,
      fetchedAt: now,
      expiresAt: now + RECIPE_TTL_MS,
    };
    const existing = await ctx.db
      .query("recipeCache")
      .withIndex("by_url_key", (q) => q.eq("urlKey", args.urlKey))
      .unique();
    if (existing === null) await ctx.db.insert("recipeCache", fields);
    else await ctx.db.patch(existing._id, fields);

    // Whatever this recipe called for is food by definition. Recorded here
    // because it is the one place every parsed recipe passes through, and it
    // costs a handful of writes against a page we already paid to read.
    await learnFoodWords(ctx, args.recipe.ingredients);
    return null;
  },
});

/** Words one recipe may contribute, so a pathological page cannot flood this. */
const MAX_NEW_WORDS_PER_RECIPE = 40;

async function learnFoodWords(
  ctx: MutationCtx,
  ingredients: readonly { item: string }[],
): Promise<void> {
  const candidates = new Set<string>();
  for (const ingredient of ingredients) {
    for (const word of wordsIn(ingredient.item)) candidates.add(word);
  }

  let added = 0;
  for (const word of candidates) {
    if (added >= MAX_NEW_WORDS_PER_RECIPE) break;
    const seen = await ctx.db
      .query("foodWords")
      .withIndex("by_word", (q) => q.eq("word", word))
      .unique();
    if (seen !== null) continue;
    await ctx.db.insert("foodWords", { word, firstSeenAt: Date.now() });
    added += 1;
  }
}

/**
 * The learned half of the food vocabulary.
 *
 * Bounded: distinct food words converge on a few thousand however many recipes
 * are read, so this stays a small read rather than growing with the cache.
 */
export const knownFoodWords = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const rows = await ctx.db.query("foodWords").take(MAX_LEARNED_WORDS);
    return rows.map((row) => row.word);
  },
});

const MAX_LEARNED_WORDS = 3_000;

// --------------------------------------------------------------- store probes

const lookupStatus = v.union(
  v.literal("found"),
  v.literal("none"),
  v.literal("blocked"),
);
const product = v.object({ title: v.string(), url: v.string() });

export const getStoreLookup = internalQuery({
  args: { lookupKey: v.string() },
  returns: v.union(
    v.null(),
    v.object({ status: lookupStatus, products: v.array(product) }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("storeLookups")
      .withIndex("by_lookup_key", (q) => q.eq("lookupKey", args.lookupKey))
      .unique();
    if (row === null || row.expiresAt <= Date.now()) return null;
    return { status: row.status, products: row.products };
  },
});

export const putStoreLookup = internalMutation({
  args: {
    lookupKey: v.string(),
    storeSlug: v.string(),
    itemSlug: v.string(),
    status: lookupStatus,
    products: v.array(product),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    // A store that blocked us is worth asking again sooner than one that
    // answered honestly that it has nothing.
    const ttl = args.status === "blocked" ? STORE_BLOCKED_TTL_MS : STORE_TTL_MS;
    const fields = { ...args, fetchedAt: now, expiresAt: now + ttl };

    const existing = await ctx.db
      .query("storeLookups")
      .withIndex("by_lookup_key", (q) => q.eq("lookupKey", args.lookupKey))
      .unique();
    if (existing === null) await ctx.db.insert("storeLookups", fields);
    else await ctx.db.patch(existing._id, fields);
    return null;
  },
});
