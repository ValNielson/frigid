"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  FIRECRAWL_MAX_AGE_MS,
  MAX_MERCHANTS_PER_RUN,
  matchIngredients,
  splitStores,
} from "./policy";

/**
 * The one entrypoint for finding deals, whether a prompt, the cron, or the
 * recipe branch asked for it.
 *
 * Always scheduled, never awaited by its caller: a search, several scrapes, and
 * a model call together exceed a single action's request window, which is why
 * the product tells people their results arrive by email.
 *
 * Every stage is bounded. Merchants per run are capped and the ones dropped are
 * recorded, so a truncated run cannot be mistaken for full coverage.
 */

type ExtractedCoupon = {
  title: string;
  details?: string;
  code?: string;
  discount?: string;
  itemTerms?: string[];
  expiresAt?: string;
};

type SelectedPick = { coupon: Candidate; reason: string };

type Candidate = {
  _id: Id<"coupons">;
  merchantId: Id<"merchants">;
  title: string;
  details?: string;
  code?: string;
  discount?: string;
  itemTerms: string[];
  tags: string[];
  expiresAt?: number;
  sourceUrl?: string;
};

export const execute = internalAction({
  args: {
    userId: v.id("users"),
    trigger: v.string(),
    ingredients: v.optional(v.array(v.string())),
    sendEmail: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const runId = await ctx.runMutation(internal.deals.data.startRun, {
      userId: args.userId,
      kind: args.ingredients === undefined ? "deals" : "ingredients",
      trigger: args.trigger,
      now,
    });

    const counts = {
      merchants: 0,
      scraped: 0,
      couponsFound: 0,
      couponsMatched: 0,
    };
    let skipped: string[] = [];

    try {
      const inputs = await ctx.runQuery(internal.deals.data.runInputs, {
        userId: args.userId,
      });
      if (inputs === null) {
        throw new Error("No profile for this user yet");
      }

      const { domains, vague } = splitStores(inputs.stores);

      // The planner is consulted only for what the chain map cannot answer: a
      // city we have never resolved, or a store named as a category. Someone
      // who checked only national chains in a known city gets here free.
      let planQueries: string[] = [];
      let planDomains: string[] = [];

      if (inputs.location.length > 0) {
        const place = await ctx.runAction(
          internal.deals.plan.normalizeLocation,
          { raw: inputs.location },
        );
        if (place !== null) {
          const plan = await ctx.runAction(
            internal.deals.plan.planForLocation,
            {
              city: place.city,
              state: place.state,
              vagueStores: vague,
            },
          );
          planQueries = plan.queries;
          planDomains = plan.targetUrls;
        }
      }

      const wanted = [...new Set([...domains, ...planDomains])];
      counts.merchants = wanted.length;

      const targets = wanted.slice(0, MAX_MERCHANTS_PER_RUN);
      skipped = wanted.slice(MAX_MERCHANTS_PER_RUN);

      const query =
        planQueries[0] ?? "weekly ad grocery deals this week prices";

      for (const domain of targets) {
        const pages = await ctx.runAction(api.firecrawl.searchDeals, {
          query,
          includeDomains: [domain],
          limit: 2,
          maxAgeMs: FIRECRAWL_MAX_AGE_MS,
        });

        const merchantId = await ctx.runMutation(
          internal.deals.data.upsertMerchant,
          {
            name: domain,
            domain,
            kind: "grocery",
            source: "static",
            now,
          },
        );
        if (merchantId === null) continue;

        counts.scraped += 1;

        for (const page of pages) {
          if (page.coupons.length === 0) continue;
          const written = await ctx.runMutation(
            internal.deals.data.upsertCoupons,
            {
              merchantId,
              domain,
              // Scraped from a public page, so it belongs to nobody and serves
              // everyone who shops there.
              userId: null,
              coupons: page.coupons.map((coupon: ExtractedCoupon) => ({
                ...coupon,
                itemTerms: coupon.itemTerms ?? [],
                tags: [],
                // Firecrawl returns a date string; anything unparseable is
                // dropped rather than stored as a wrong expiry.
                expiresAt: parseExpiry(coupon.expiresAt),
                sourceKind: "scrape",
                sourceUrl: page.url.length > 0 ? page.url : undefined,
              })),
              now,
            },
          );
          counts.couponsFound += written.inserted + written.updated;
        }

        await ctx.runMutation(internal.deals.data.markScraped, {
          merchantId,
          now,
        });
      }

      const merchants = await ctx.runQuery(
        internal.deals.data.merchantsByDomains,
        { domains: wanted },
      );

      let candidates: Candidate[] = await ctx.runQuery(
        internal.deals.data.couponsForUser,
        {
          userId: args.userId,
          merchantIds: merchants.map(
            (merchant: { _id: Id<"merchants"> }) => merchant._id,
          ),
          now,
        },
      );

      // An ingredient run narrows to the recipe before the model is asked
      // anything, so a ten-ingredient recipe costs one small call, not ten.
      if (args.ingredients !== undefined) {
        candidates = matchIngredients(candidates, args.ingredients);
      }

      const selection = await ctx.runAction(
        internal.deals.match.selectForProfile,
        {
          coupons: candidates,
          allergies: inputs.allergies,
          promptContext: inputs.promptContext,
        },
      );
      counts.couponsMatched = selection.picks.length;

      if (args.sendEmail !== false && selection.picks.length > 0) {
        await ctx.runAction(internal.deals.digest.send, {
          userId: args.userId,
          picks: selection.picks.map((pick: SelectedPick) => ({
            title: pick.coupon.title,
            discount: pick.coupon.discount,
            details: pick.coupon.details,
            code: pick.coupon.code,
            sourceUrl: pick.coupon.sourceUrl,
            reason: pick.reason,
          })),
        });
      }

      await ctx.runMutation(internal.deals.data.finishRun, {
        runId,
        status: "done",
        counts,
        skippedMerchants: skipped.length > 0 ? skipped : undefined,
        now: Date.now(),
      });
    } catch (error) {
      await ctx.runMutation(internal.deals.data.finishRun, {
        runId,
        status: "failed",
        counts,
        skippedMerchants: skipped.length > 0 ? skipped : undefined,
        error: error instanceof Error ? error.message : String(error),
        now: Date.now(),
      });
      throw error;
    }

    return null;
  },
});

/** A date we can trust, or nothing. */
function parseExpiry(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}
