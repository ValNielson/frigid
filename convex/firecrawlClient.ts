"use node";

/**
 * Every Firecrawl call the app makes, wrapped in the things that keep it
 * affordable and honest: the Convex cache, credit accounting, bot-wall
 * detection, and a fixture mode for developing without spending anything.
 *
 * Nothing else should talk to Firecrawl directly. Going around this module
 * means going around the cache, which is the whole cost model.
 */

import Firecrawl from "firecrawl";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { optionalEnv, requireEnv } from "./env";
import { BOT_WALL_PATTERN, MAX_STORED_MARKDOWN, SEARCH_CREDIT_COST, SCRAPE_CREDIT_COST } from "./recipePolicy";
import { SEARCH_FIXTURES, SCRAPE_FIXTURES } from "./fixtures/recipeFixtures";

/** Fixture mode short-circuits every paid call. See the module docs. */
function usingFixtures(): boolean {
  return optionalEnv("FIRECRAWL_MODE", "live") === "fixture";
}

function client() {
  return new Firecrawl({ apiKey: requireEnv("FIRECRAWL_API_KEY") });
}

type SearchResult = { url: string; title: string; description?: string };

/**
 * Convex infers an action's type from its handler, and these handlers call
 * internal functions, so the inference goes circular. Naming the return types
 * explicitly is the standard way to cut that loop.
 */
type SearchOutcome = {
  results: SearchResult[];
  creditsUsed: number;
  cached: boolean;
};

type ScrapeOutcome = {
  rawHtml: string | null;
  markdown: string;
  title?: string;
  creditsUsed: number;
  cached: boolean;
  blocked: boolean;
};

const searchResult = v.object({
  url: v.string(),
  title: v.string(),
  description: v.optional(v.string()),
});

/**
 * Web search, cached by normalized query.
 *
 * `includeDomains` is a hint, not a guarantee — we have watched YouTube results
 * come back from a domain-restricted search — so callers must still filter the
 * results themselves.
 */
export const searchWeb = internalAction({
  args: {
    query: v.string(),
    queryKey: v.string(),
    includeDomains: v.optional(v.array(v.string())),
    limit: v.number(),
  },
  returns: v.object({
    results: v.array(searchResult),
    creditsUsed: v.number(),
    cached: v.boolean(),
  }),
  handler: async (ctx, args): Promise<SearchOutcome> => {
    const cached = await ctx.runQuery(internal.recipeCache.getSearch, {
      queryKey: args.queryKey,
    });
    if (cached !== null) return { results: cached, creditsUsed: 0, cached: true };

    let results: SearchResult[];

    if (usingFixtures()) {
      results = SEARCH_FIXTURES[args.queryKey] ?? SEARCH_FIXTURES["__default"] ?? [];
    } else {
      const response = await client().search(args.query, {
        limit: args.limit,
        sources: ["web"],
        ...(args.includeDomains !== undefined
          ? { includeDomains: args.includeDomains }
          : {}),
      });

      // The element type is SearchResultWeb | Document — it changes when
      // scrapeOptions is passed. We never pass it, but narrow rather than
      // trust that, because the compiler cannot tell them apart for us.
      results = (response.web ?? []).flatMap((entry) => {
        if (!("url" in entry) || typeof entry.url !== "string") return [];
        const url = entry.url;
        const title =
          "title" in entry && typeof entry.title === "string" ? entry.title : url;
        const description =
          "description" in entry && typeof entry.description === "string"
            ? entry.description
            : undefined;
        return [{ url, title, ...(description !== undefined ? { description } : {}) }];
      });
    }

    await ctx.runMutation(internal.recipeCache.putSearch, {
      queryKey: args.queryKey,
      results,
    });

    return {
      results,
      creditsUsed: usingFixtures() ? 0 : SEARCH_CREDIT_COST,
      cached: false,
    };
  },
});

/**
 * Scrapes one page, returning the raw HTML we parse JSON-LD out of.
 *
 * Only the markdown is cached: the rawHtml regularly exceeds a megabyte and is
 * useless once parsed. That means a cache hit can serve the free markdown
 * fallback but not a fresh JSON-LD parse, which is fine — the parsed recipe is
 * cached separately and is what callers actually want.
 *
 * `maxAge` is deliberately 0. Firecrawl's own index cache bills the same credit
 * as a live fetch, so the only cache worth having is ours.
 */
export const scrapePage = internalAction({
  args: { url: v.string(), urlKey: v.string() },
  returns: v.object({
    rawHtml: v.union(v.string(), v.null()),
    markdown: v.string(),
    title: v.optional(v.string()),
    creditsUsed: v.number(),
    cached: v.boolean(),
    blocked: v.boolean(),
  }),
  handler: async (ctx, args): Promise<ScrapeOutcome> => {
    const cachedPage = await ctx.runQuery(internal.recipeCache.getPage, {
      urlKey: args.urlKey,
    });
    if (cachedPage !== null) {
      return {
        rawHtml: null,
        markdown: cachedPage.markdown,
        ...(cachedPage.title !== undefined ? { title: cachedPage.title } : {}),
        creditsUsed: 0,
        cached: true,
        blocked: false,
      };
    }

    let rawHtml = "";
    let markdown = "";
    let title: string | undefined;

    if (usingFixtures()) {
      const fixture = SCRAPE_FIXTURES[args.urlKey];
      if (fixture === undefined) {
        return {
          rawHtml: null, markdown: "", creditsUsed: 0, cached: false, blocked: true,
        };
      }
      rawHtml = fixture.rawHtml;
      markdown = fixture.markdown;
      title = fixture.title;
    } else {
      const document = await client().scrape(args.url, {
        formats: ["markdown", "rawHtml"],
        // JSON-LD lives in <head> or as a standalone body script, so trimming
        // to the main content would throw away the thing we came for.
        onlyMainContent: false,
        blockAds: true,
        timeout: 25_000,
        maxAge: 0,
      });
      rawHtml = document.rawHtml ?? "";
      markdown = document.markdown ?? "";
      const metaTitle = document.metadata?.title;
      title = typeof metaTitle === "string" ? metaTitle : undefined;
    }

    // Firecrawl reports a bot wall as a successful scrape and bills for it, so
    // recognising the content is on us. Caching a CAPTCHA as a recipe would be
    // worse than the wasted credit.
    const blocked =
      (rawHtml.length === 0 && markdown.length === 0) ||
      BOT_WALL_PATTERN.test(markdown.slice(0, 4_000));

    if (!blocked) {
      await ctx.runMutation(internal.recipeCache.putPage, {
        urlKey: args.urlKey,
        url: args.url,
        markdown: markdown.slice(0, MAX_STORED_MARKDOWN),
        ...(title !== undefined ? { title } : {}),
        hadJsonLd: rawHtml.includes("application/ld+json"),
      });
    }

    return {
      rawHtml,
      markdown,
      ...(title !== undefined ? { title } : {}),
      creditsUsed: usingFixtures() ? 0 : SCRAPE_CREDIT_COST,
      cached: false,
      blocked,
    };
  },
});

/**
 * What the Firecrawl account has left.
 *
 * Exists so a job's own credit tally can be checked against the source of
 * truth. If those two numbers disagree, the budget guard is fiction.
 */
export const creditUsage = internalAction({
  args: {},
  returns: v.object({
    remainingCredits: v.number(),
    planCredits: v.union(v.number(), v.null()),
  }),
  handler: async () => {
    const usage = await client().getCreditUsage();
    return {
      remainingCredits: usage.remainingCredits,
      planCredits: usage.planCredits ?? null,
    };
  },
});
