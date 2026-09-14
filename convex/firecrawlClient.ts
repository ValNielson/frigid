"use node";

/**
 * Every Firecrawl call the app makes, wrapped in the things that keep it
 * affordable and honest: the Convex cache, credit accounting, bot-wall
 * detection, and a fixture mode for developing without spending anything.
 *
 * Nothing else should talk to Firecrawl directly. Going around this module
 * means going around the cache, which is the whole cost model. There used to be
 * a second client in firecrawl.ts serving the coupon pipeline, and the daily
 * budget guard could not see a single credit it spent — that is what a second
 * client costs, so there is one.
 *
 * Every paid call records its own spend before returning. Callers used to do it
 * and one of them simply did not.
 */

import Firecrawl from "firecrawl";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { optionalEnv, requireEnv } from "./env";
import { BOT_WALL_PATTERN, MAX_STORED_MARKDOWN, SEARCH_CREDIT_COST, SCRAPE_CREDIT_COST } from "./recipePolicy";
import {
  FIND_SITE_CREDIT_COST,
  SEARCH_DEALS_CREDIT_COST,
  COUPON_DEPARTMENTS,
  hasImplausiblePrice,
  isDirectorySite,
  keepAsFood,
  normalizeDomain,
  repairPrices,
} from "./deals/policy";
import { SEARCH_FIXTURES, SCRAPE_FIXTURES } from "./fixtures/recipeFixtures";
import { looksLikeFood } from "./foodVocabulary";
import type { GenericActionCtx } from "convex/server";
import type { DataModel } from "./_generated/dataModel";

type Ctx = GenericActionCtx<DataModel>;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Thrown when the limiter says the wait is longer than it is worth. */
export const RATE_LIMIT_SKIPPED = "Firecrawl rate limit: skipped";

/**
 * Firecrawl tells you how long to wait when it rejects you. Reading that beats
 * guessing at a backoff.
 */
function retryAfterMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/rate limit/i.test(message)) return null;
  const seconds = /retry after (\d+)\s*s/i.exec(message)?.[1];
  // A rate-limited request is rejected, not served, so this is a fixed 20s
  // rather than something proportional to what we were trying to do.
  return seconds === undefined ? 20_000 : Number(seconds) * 1_000 + 1_000;
}

/**
 * Every paid Firecrawl call goes through here.
 *
 * Two layers, because the first one is built on a guess. The limiter spaces
 * requests using per-call weights we cannot verify from outside; when those
 * weights are wrong Firecrawl says so, and its own retry-after is ground truth.
 *
 * Retrying here does not contradict the "pace rather than retry" rule elsewhere
 * in this codebase. That rule is about a scrape that failed — which was billed.
 * A rate-limited request is rejected before it costs anything, so waiting and
 * asking again spends nothing but time.
 */
async function throttled<T>(
  ctx: Ctx,
  weight: number,
  call: () => Promise<T>,
): Promise<T> {
  const slot = await ctx.runMutation(internal.firecrawlRate.reserve, {
    weight,
    now: Date.now(),
  });
  if (slot.deferred) throw new Error(RATE_LIMIT_SKIPPED);
  if (slot.waitMs > 0) await pause(slot.waitMs);

  try {
    return await call();
  } catch (error) {
    const retry = retryAfterMs(error);
    if (retry === null) throw error;
    await pause(retry);
    return await call();
  }
}

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

type DealPage = {
  url: string;
  title: string | null;
  coupons: ExtractedCoupon[];
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
      const response = await throttled(ctx, 1, () =>
        client().search(args.query, {
        limit: args.limit,
        sources: ["web"],
        ...(args.includeDomains !== undefined
          ? { includeDomains: args.includeDomains }
          : {}),
        }),
      );

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
      const document = await throttled(ctx, 1, () =>
        client().scrape(args.url, {
        formats: ["markdown", "rawHtml"],
        // JSON-LD lives in <head> or as a standalone body script, so trimming
        // to the main content would throw away the thing we came for.
        onlyMainContent: false,
        blockAds: true,
        timeout: 25_000,
        maxAge: 0,
        }),
      );
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
 * truth. If those two numbers disagree, the budget guard is fiction. Run by
 * hand rather than called by the product, which is why it has no call sites.
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

/**
 * JSON Schema handed to Firecrawl's `json` format.
 *
 * Firecrawl does the extraction itself, so a page of weekly-ad markup becomes
 * structured offers in the same call that fetches it. That is one network round
 * trip and no model tokens of ours, which is why there is no OpenAI call
 * anywhere in the scrape path.
 *
 * A plain object rather than a Zod schema: the SDK accepts either, and this
 * avoids taking on zod for one literal.
 */
const COUPON_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    coupons: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "The offer, as shown" },
          department: {
            type: "string",
            enum: [...COUPON_DEPARTMENTS],
            description:
              "Required. Where this belongs in a store. Use household, pet or " +
              "apparel for anything a person does not eat — cookware, dog " +
              "food, homeware, clothing — and 'other' only when genuinely " +
              "unsure. These pages mix groceries with everything else.",
          },
          details: { type: "string" },
          code: {
            type: "string",
            description: "Promo code, if one is printed",
          },
          discount: {
            type: "string",
            description:
              "The saving, e.g. '2 for $6' or '30% off'. Write the decimal " +
              "point: $1.49, not $149.",
          },
          primaryItem: {
            type: "string",
            description:
              "Required. The single food this offer is actually for, lowercase " +
              "and singular, brand names dropped. For 'Goldfish Cheddar Baked " +
              "Snack Crackers' return 'cracker', not 'cheddar' — the offer is " +
              "for crackers. For 'Boneless Chicken Breast' return 'chicken'.",
          },
          itemTerms: {
            type: "array",
            items: { type: "string" },
            description:
              "Required. The generic food words in this offer, lowercase and " +
              "singular, with brand names dropped. For 'Specially Selected " +
              "Apple Cinnamon Brioche Ring' return ['apple','cinnamon'," +
              "'brioche','bread']. Used to match offers to recipes.",
          },
          expiresAt: {
            type: "string",
            description: "ISO 8601 date the offer ends, if stated",
          },
        },
        required: ["title", "itemTerms", "department", "primaryItem"],
      },
    },
  },
  required: ["coupons"],
} as const;

const EXTRACTION_PROMPT =
  "Extract every discounted product on this page that has a price, saving, or " +
  "promo code. Ignore navigation, ads for other sites, and store hours. Give " +
  "each one a department — these pages mix groceries with cookware, pet supplies " +
  "and clothing, and the non-grocery rows are discarded afterwards, so put them " +
  "in household, pet or apparel rather than forcing them into a food aisle. " +
  "Always set department and primaryItem; they are required and a row missing " +
  "either is thrown away. Leave the optional fields out rather than guessing.";

const couponValidator = v.object({
  title: v.string(),
  details: v.optional(v.string()),
  code: v.optional(v.string()),
  discount: v.optional(v.string()),
  primaryItem: v.optional(v.string()),
  itemTerms: v.optional(v.array(v.string())),
  expiresAt: v.optional(v.string()),
});

type ExtractedCoupon = {
  title: string;
  department?: string;
  details?: string;
  code?: string;
  discount?: string;
  primaryItem?: string;
  itemTerms?: string[];
  expiresAt?: string;
};

/** Pulls the extracted payload off a search result or scrape document. */
function couponsFrom(
  document: unknown,
  isKnownFood: (text: string) => boolean,
): ExtractedCoupon[] {
  if (typeof document !== "object" || document === null) return [];
  const json = (document as { json?: unknown }).json;
  if (typeof json !== "object" || json === null) return [];
  const coupons = (json as { coupons?: unknown }).coupons;
  if (!Array.isArray(coupons)) return [];
  return (
    coupons
      .filter(
        (coupon): coupon is ExtractedCoupon =>
          typeof coupon === "object" &&
          coupon !== null &&
          typeof (coupon as { title?: unknown }).title === "string" &&
          (coupon as { title: string }).title.trim().length > 0,
      )
      // Was a boolean the model could simply omit, which read as "keep" and
      // stored BBQ tools, a crockpot and dog food as recipe ingredients. Now a
      // department, with a category backstop and the food vocabulary as the
      // tie-breaker for anything the extractor could not place.
      .filter((coupon) => keepAsFood(coupon, isKnownFood))
      .map(clean)
  );
}

/**
 * Drops the empty strings Firecrawl returns for fields it could not find.
 *
 * The schema marks them optional, but extraction fills them in as "" rather
 * than omitting them, and an empty promo code stored as a real one would end up
 * printed in a digest as something to type at the register.
 *
 * department is dropped here rather than stored: it exists to make the food
 * filter reliable during extraction, and the shopping list derives its own
 * grouping from the ingredient rather than the offer.
 */
function clean(coupon: ExtractedCoupon): ExtractedCoupon {
  const text = (value: string | undefined) => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
  };

  const priced = (value: string | undefined) => {
    const trimmed = text(value);
    return trimmed === undefined ? undefined : repairPrices(trimmed);
  };

  // Weekly-ad pages render cents as superscript, so extraction flattens
  // "$1.49" to "$149". Repaired here because this is the one place both fields
  // pass through; a discount still absurd afterwards is dropped rather than
  // printed, which is the rule recipeEmail already states for prices.
  const discount = priced(coupon.discount);

  return {
    title: coupon.title.trim(),
    details: priced(coupon.details),
    code: text(coupon.code),
    discount:
      discount !== undefined && hasImplausiblePrice(discount)
        ? undefined
        : discount,
    primaryItem: text(coupon.primaryItem)?.toLowerCase(),
    itemTerms: (coupon.itemTerms ?? [])
      .map((term) => term.trim().toLowerCase())
      .filter((term) => term.length > 0),
    expiresAt: text(coupon.expiresAt),
  };
}

/**
 * Finds a merchant's live deal pages and extracts the offers in one call.
 *
 * Scoped by domain rather than aimed at a guessed weekly-ad URL, because those
 * paths move and a stale constant costs a Firecrawl call that 404s while
 * looking like a merchant with no deals.
 */
export const searchDeals = internalAction({
  args: {
    query: v.string(),
    includeDomains: v.optional(v.array(v.string())),
    limit: v.optional(v.number()),
    maxAgeMs: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      url: v.string(),
      title: v.union(v.string(), v.null()),
      coupons: v.array(couponValidator),
    }),
  ),
  handler: async (ctx, args): Promise<DealPage[]> => {
    // Fetched once for the whole page set rather than per coupon. Widens the
    // static vocabulary with every ingredient the product has ever parsed.
    const learned = new Set(
      await ctx.runQuery(internal.recipeCache.knownFoodWords, {}),
    );
    const isKnownFood = (text: string) => looksLikeFood(text, learned);

    // A search plus server-side extraction per result. An estimate; the 429
    // handler is what covers it being wrong.
    const results = await throttled(ctx, 1 + (args.limit ?? 3), () =>
      client().search(args.query, {
        limit: args.limit ?? 3,
        includeDomains: args.includeDomains,
      scrapeOptions: {
        formats: [
          {
            type: "json",
            prompt: EXTRACTION_PROMPT,
            schema: COUPON_EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
          },
        ],
          maxAge: args.maxAgeMs,
        },
      }),
    );

    await ctx.runMutation(internal.credits.record, {
      feature: "deals",
      credits: SEARCH_DEALS_CREDIT_COST,
      at: Date.now(),
    });

    return (results.web ?? []).flatMap((entry) => {
      const record = entry as {
        url?: string;
        title?: string;
        metadata?: { url?: string; title?: string };
      };
      const url = record.url ?? record.metadata?.url;
      // A result with no URL cannot be attributed to a page, and a coupon whose
      // source is the empty string is worse than one we never stored.
      if (url === undefined || url.length === 0) return [];
      return [
        {
          url,
          title: record.title ?? record.metadata?.title ?? null,
          coupons: couponsFrom(entry, isKnownFood),
        },
      ];
    });
  },
});

/**
 * Resolves a business name to its real domain.
 *
 * Exists because a model asked for domains directly gets them wrong more often
 * than right: of five it proposed for one city, one was usable — the others
 * were a dead domain, a business with no deals page, a farmers market, and the
 * right chain's store in a city 65 miles away. A search returns what is
 * actually there, so the model only has to know the business exists.
 *
 * Directory listings are rejected here rather than by the caller: a name search
 * for a small shop often puts its Yelp or Facebook page above its own site, and
 * a directory sets no prices.
 */
export const findSite = internalAction({
  args: { query: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args): Promise<string | null> => {
    const results = await throttled(ctx, 1, () =>
      client().search(args.query, { limit: 3 }),
    );

    await ctx.runMutation(internal.credits.record, {
      feature: "deals-plan",
      credits: FIND_SITE_CREDIT_COST,
      at: Date.now(),
    });

    for (const entry of results.web ?? []) {
      const record = entry as { url?: string; metadata?: { url?: string } };
      const url = record.url ?? record.metadata?.url;
      if (url === undefined) continue;
      const host = normalizeDomain(url);
      if (host === null || isDirectorySite(host)) continue;
      return host;
    }

    return null;
  },
});
