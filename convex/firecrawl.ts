"use node";

import Firecrawl from "firecrawl";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { requireEnv } from "./env";

export const scrape = action({
  args: { url: v.string() },
  returns: v.object({
    markdown: v.string(),
    title: v.union(v.string(), v.null()),
    sourceUrl: v.union(v.string(), v.null()),
  }),
  handler: async (_ctx, args) => {
    const firecrawl = new Firecrawl({
      apiKey: requireEnv("FIRECRAWL_API_KEY"),
    });
    const document = await firecrawl.scrape(args.url, {
      formats: ["markdown"],
    });
    if (!document.markdown) {
      throw new Error(`Firecrawl returned no markdown for ${args.url}`);
    }
    return {
      markdown: document.markdown,
      title: document.metadata?.title ?? null,
      sourceUrl: document.metadata?.url ?? null,
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
          isFood: {
            type: "boolean",
            description:
              "True only if this is food or drink a person consumes. False " +
              "for homeware, decor, clothing, toys, and seasonal goods.",
          },
          details: { type: "string" },
          code: {
            type: "string",
            description: "Promo code, if one is printed",
          },
          discount: {
            type: "string",
            description: "The saving, e.g. '2 for $6' or '30% off'",
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
        required: ["title", "itemTerms", "isFood"],
      },
    },
  },
  required: ["coupons"],
} as const;

const EXTRACTION_PROMPT =
  "Extract every discounted product on this page that has a price, saving, or " +
  "promo code. Ignore navigation, ads for other sites, and store hours. Set " +
  "isFood honestly for each one — these pages mix groceries with homeware, and " +
  "the non-food rows are discarded afterwards. Leave a field out rather than " +
  "guessing at it.";

const couponValidator = v.object({
  title: v.string(),
  details: v.optional(v.string()),
  code: v.optional(v.string()),
  discount: v.optional(v.string()),
  itemTerms: v.optional(v.array(v.string())),
  expiresAt: v.optional(v.string()),
});

type ExtractedCoupon = {
  title: string;
  isFood?: boolean;
  details?: string;
  code?: string;
  discount?: string;
  itemTerms?: string[];
  expiresAt?: string;
};

/** Pulls the extracted payload off a search result or scrape document. */
function couponsFrom(document: unknown): ExtractedCoupon[] {
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
      // Asking for a boolean per row holds far better than a "food only"
      // instruction in the prompt, which these mixed pages routinely override.
      .filter((coupon) => coupon.isFood !== false)
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
 * isFood is dropped here rather than stored: it exists to make the food filter
 * reliable during extraction, and carries no meaning once the row is kept.
 */
function clean(coupon: ExtractedCoupon): ExtractedCoupon {
  const text = (value: string | undefined) => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
  };

  return {
    title: coupon.title.trim(),
    details: text(coupon.details),
    code: text(coupon.code),
    discount: text(coupon.discount),
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
 * paths move and a stale constant costs a fetch that 404s while looking like a
 * merchant with no deals.
 */
export const searchDeals = action({
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
  handler: async (_ctx, args) => {
    const firecrawl = new Firecrawl({
      apiKey: requireEnv("FIRECRAWL_API_KEY"),
    });

    const results = await firecrawl.search(args.query, {
      limit: args.limit ?? 3,
      includeDomains: args.includeDomains,
      scrapeOptions: {
        formats: [
          {
            type: "json",
            prompt: EXTRACTION_PROMPT,
            schema: COUPON_EXTRACTION_SCHEMA as unknown as Record<
              string,
              unknown
            >,
          },
        ],
        maxAge: args.maxAgeMs,
      },
    });

    const web = results.web ?? [];
    return web.map((entry) => {
      const record = entry as {
        url?: string;
        title?: string;
        metadata?: { url?: string; title?: string };
      };
      return {
        url: record.url ?? record.metadata?.url ?? "",
        title: record.title ?? record.metadata?.title ?? null,
        coupons: couponsFrom(entry),
      };
    });
  },
});

/** Extracts offers from one known deal page. */
export const scrapeDeals = action({
  args: { url: v.string(), maxAgeMs: v.optional(v.number()) },
  returns: v.object({
    sourceUrl: v.union(v.string(), v.null()),
    coupons: v.array(couponValidator),
  }),
  handler: async (_ctx, args) => {
    const firecrawl = new Firecrawl({
      apiKey: requireEnv("FIRECRAWL_API_KEY"),
    });

    const document = await firecrawl.scrape(args.url, {
      formats: [
        {
          type: "json",
          prompt: EXTRACTION_PROMPT,
          schema: COUPON_EXTRACTION_SCHEMA as unknown as Record<
            string,
            unknown
          >,
        },
      ],
      maxAge: args.maxAgeMs,
    });

    return {
      sourceUrl: document.metadata?.url ?? args.url,
      coupons: couponsFrom(document),
    };
  },
});
