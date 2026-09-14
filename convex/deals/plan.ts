"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { locationKey, normalizeDomain } from "./policy";

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
          name: { type: "string" },
          domain: { type: "string", description: "Bare hostname, or empty" },
          kind: { type: "string", enum: ["grocery", "restaurant", "other"] },
        },
        required: ["name", "domain", "kind"],
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

    const raw = await ctx.runAction(api.openai.structured, {
      prompt: `Location: ${args.raw}`,
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
    if (city === undefined) return null;

    const resolved = {
      city,
      state: optional(parsed.state),
      zip: optional(parsed.zip),
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
  args: {
    city: v.string(),
    state: v.optional(v.string()),
    vagueStores: v.array(v.string()),
  },
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
    });
    if (cached !== null) return cached;

    const place =
      args.state === undefined ? args.city : `${args.city}, ${args.state}`;
    const wanted =
      args.vagueStores.length > 0
        ? `They also shop at: ${args.vagueStores.join("; ")}.`
        : "";

    const raw = await ctx.runAction(api.openai.structured, {
      prompt: `City: ${place}. ${wanted}`,
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
      localMerchants?: { name: string; domain: string; kind: string }[];
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { queries: [], targetUrls: [] };
    }

    const now = Date.now();
    const queries = (parsed.queries ?? []).filter((q) => q.trim().length > 0);

    // Local merchants become rows immediately, so a later run in the same city
    // finds them without re-planning, and so the scraper can reach them the
    // same way it reaches the chains.
    const targetUrls: string[] = [];
    for (const merchant of parsed.localMerchants ?? []) {
      const domain = normalizeDomain(merchant.domain ?? "");
      if (domain === null) continue;
      await ctx.runMutation(internal.deals.data.upsertMerchant, {
        name: merchant.name,
        domain,
        city: key,
        kind: merchant.kind ?? "other",
        source: "codex",
        now,
      });
      targetUrls.push(domain);
    }

    const plan = { queries, targetUrls };
    await ctx.runMutation(internal.deals.data.savePlan, {
      locationKey: key,
      ...plan,
      now,
    });

    return plan;
  },
});
