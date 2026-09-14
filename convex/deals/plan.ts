"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import type { GenericActionCtx } from "convex/server";
import type { DataModel } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import {
  MAX_CITY_MERCHANTS,
  MAX_MERCHANTS_PER_STORE_PLAN,
  isPlausibleCity,
  locationKey,
  normalizeState,
  normalizeZip,
  singleLine,
} from "./policy";

/** Free text we are willing to paste into a prompt. */
const MAX_LOCATION_CHARS = 120;

/**
 * Turns a user's onboarding answers into something Firecrawl can execute.
 *
 * Two model calls at most, and both are cached for everyone who follows: one to
 * normalize the free-text location, one to plan queries for a city. A user
 * whose stores are all named chains and whose city someone else already asked
 * about costs nothing here at all.
 */

const LOCATION_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    city: { type: "string" },
    state: { type: "string", description: "Two-letter code, or empty" },
    zip: { type: "string", description: "Five digits, or empty" },
  },
  required: ["city", "state", "zip"],
  additionalProperties: false,
});

const PLAN_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    queries: {
      type: "array",
      description: "Web searches that surface current grocery deals here",
      items: { type: "string" },
    },
    localMerchants: {
      type: "array",
      description:
        "Real, named food businesses in this city that publish deals or run " +
        "a mailing list. Leave empty rather than inventing one.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "The business name only" },
          kind: { type: "string", enum: ["grocery", "restaurant", "other"] },
        },
        required: ["name", "kind"],
        additionalProperties: false,
      },
    },
  },
  required: ["queries", "localMerchants"],
  additionalProperties: false,
});

type NormalizedLocation = { city: string; state?: string; zip?: string };

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Resolves a free-text location, caching the result against the raw answer.
 *
 * "Grand Rapids, MI", "grand rapids", and "49503" are one place spelled three
 * ways, and without this each spelling would plan and cache separately.
 */
export const normalizeLocation = internalAction({
  args: { raw: v.string() },
  returns: v.union(
    v.object({
      city: v.string(),
      state: v.optional(v.string()),
      zip: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args): Promise<NormalizedLocation | null> => {
    const cached = await ctx.runQuery(internal.deals.data.getLocation, {
      raw: args.raw,
    });
    if (cached !== null) return cached;

    const raw = await ctx.runAction(internal.openai.structured, {
      // Flattened and capped before it reaches the model. This is the one
      // field in the product where a user's free text becomes a prompt whose
      // answer is then cached for everyone.
      prompt: `Location: ${singleLine(args.raw).slice(0, MAX_LOCATION_CHARS)}`,
      schemaName: "normalized_location",
      schemaJson: LOCATION_SCHEMA,
      instructions:
        "Resolve the user's location to a US city. Given only a ZIP code, " +
        "return the city it belongs to. Return empty strings for anything you " +
        "cannot determine rather than guessing.",
    });

    let parsed: { city?: string; state?: string; zip?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    const city = optional(parsed.city);
    // A city that does not read like a place name is discarded rather than
    // cached: downstream it becomes a shared cache key and the text of the next
    // prompt, so a sentence here would propagate to every user in that key.
    if (city === undefined || !isPlausibleCity(city)) return null;

    const resolved = {
      city: city.trim(),
      state: normalizeState(parsed.state),
      zip: normalizeZip(parsed.zip),
    };

    await ctx.runMutation(internal.deals.data.saveLocation, {
      raw: args.raw,
      ...resolved,
      now: Date.now(),
    });

    return resolved;
  },
});

/**
 * The search plan for a city, cached and shared.
 *
 * Keyed on the normalized location alone. Where to find grocery deals in a city
 * has the same answer for a vegan and a carnivore — personalization happens
 * when matching, which costs nothing — so one call serves every user there.
 */
export const planForLocation = internalAction({
  args: { city: v.string(), state: v.optional(v.string()) },
  returns: v.object({
    queries: v.array(v.string()),
    targetUrls: v.array(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ queries: string[]; targetUrls: string[] }> => {
    const key = locationKey(args.city, args.state);

    const cached = await ctx.runQuery(internal.deals.data.getPlan, {
      locationKey: key,
      now: Date.now(),
    });
    if (cached !== null) return cached;

    const place =
      args.state === undefined ? args.city : `${args.city}, ${args.state}`;

    const raw = await ctx.runAction(internal.openai.structured, {
      prompt: `City: ${place}.`,
      schemaName: "deal_plan",
      schemaJson: PLAN_SCHEMA,
      instructions:
        "You are planning web searches that find current grocery and food " +
        "deals in one city. Write 3 to 5 searches likely to surface weekly " +
        "ads and current offers. Then name any real local food businesses " +
        "there that publish deals — co-ops, markets, and independent grocers " +
        "the national chains do not cover. Only name businesses you are " +
        "confident exist; an empty list is better than a plausible invention.",
    });

    let parsed: {
      queries?: string[];
      localMerchants?: { name: string; kind: string }[];
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { queries: [], targetUrls: [] };
    }

    const now = Date.now();
    const queries = (parsed.queries ?? []).filter((q) => q.trim().length > 0);

    const targetUrls = await resolveMerchants(
      ctx,
      (parsed.localMerchants ?? []).slice(0, MAX_CITY_MERCHANTS),
      place,
      key,
      now,
    );

    const plan = { queries, targetUrls };
    await ctx.runMutation(internal.deals.data.savePlan, {
      locationKey: key,
      ...plan,
      now,
    });

    return plan;
  },
});

const STORE_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    merchants: {
      type: "array",
      description:
        "Real food businesses in this city matching the description. Leave " +
        "empty rather than inventing one.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "The business name only" },
          kind: { type: "string", enum: ["grocery", "restaurant", "other"] },
        },
        required: ["name", "kind"],
        additionalProperties: false,
      },
    },
  },
  required: ["merchants"],
  additionalProperties: false,
});

/**
 * Resolves one store a user named, cached per city and store.
 *
 * Serves both a specific write-in and a category like "Local co-op or farmers
 * market": both are stable answers for a city and both are worth sharing. The
 * key is the pair, so combinations of write-ins never multiply into separate
 * city plans.
 */
export const planForStore = internalAction({
  args: {
    city: v.string(),
    state: v.optional(v.string()),
    store: v.string(),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args): Promise<string[]> => {
    const key = locationKey(args.city, args.state);
    const now = Date.now();

    const cached = await ctx.runQuery(internal.deals.data.getStorePlan, {
      locationKey: key,
      store: args.store,
      now,
    });
    if (cached !== null) return cached;

    const place =
      args.state === undefined ? args.city : `${args.city}, ${args.state}`;

    const raw = await ctx.runAction(internal.openai.structured, {
      prompt: `City: ${place}. The shopper described where they shop as: ${args.store}`,
      schemaName: "store_plan",
      schemaJson: STORE_SCHEMA,
      instructions:
        `Name up to ${MAX_MERCHANTS_PER_STORE_PLAN} real food businesses in ` +
        "this city matching how the shopper described where they shop. Only " +
        "name businesses you are confident exist; an empty list is better " +
        "than a plausible invention. Give the business name alone — the " +
        "website is looked up separately.",
    });

    let parsed: { merchants?: { name: string; kind: string }[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }

    const domains = await resolveMerchants(
      ctx,
      (parsed.merchants ?? []).slice(0, MAX_MERCHANTS_PER_STORE_PLAN),
      place,
      key,
      now,
    );

    // An empty result is stored too. It reads as "we looked", and the plan TTL
    // is what makes the pipeline try again later rather than never.
    await ctx.runMutation(internal.deals.data.saveStorePlan, {
      locationKey: key,
      store: args.store,
      domains,
      now,
    });

    return domains;
  },
});

/**
 * Turns named businesses into domains that actually exist, writing a merchant
 * row for each.
 *
 * The lookup is the point. A model asked for domains directly returned one
 * usable answer out of five for a single city: a dead domain, a shop with no
 * deals page, a farmers market, and — worst — the right chain's store in a city
 * 65 miles away, whose current, well-formed specials page would have been
 * ingested as local pricing. Searching for the name returns what is really
 * there.
 */
async function resolveMerchants(
  ctx: GenericActionCtx<DataModel>,
  merchants: { name: string; kind: string }[],
  place: string,
  city: string,
  now: number,
): Promise<string[]> {
  const domains: string[] = [];

  for (const merchant of merchants) {
    if (merchant.name.trim().length === 0) continue;

    // findSite records its own credit and already rejects directory listings.
    const domain = await ctx.runAction(internal.firecrawlClient.findSite, {
      query: `${merchant.name} ${place}`,
    });
    if (domain === null) continue;
    if (domains.includes(domain)) continue;

    await ctx.runMutation(internal.deals.data.upsertMerchant, {
      name: merchant.name,
      domain,
      city,
      kind: merchant.kind ?? "other",
      // Marks it as proposed rather than known, which is what makes the
      // geography check apply to it at scrape time.
      source: "codex",
      now,
    });
    domains.push(domain);
  }

  return domains;
}
