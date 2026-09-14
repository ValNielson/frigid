"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  FIRECRAWL_MAX_AGE_MS,
  MAX_MERCHANTS_PER_RUN,
  SEARCH_RESULTS_PER_MERCHANT,
  MAX_STORE_PLANS_PER_RUN,
  matchIngredients,
  matchesMetro,
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
      offMetroDropped: 0,
      merchantsFresh: 0,
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
      // Kept apart because the cap has to prefer stores the user actually
      // named over merchants the planner merely suggested.
      let storeDomains: string[] = [];
      let cityDomains: string[] = [];
      let metro: { city: string; state?: string; zip?: string } | null = null;

      if (inputs.location.length > 0) {
        metro = await ctx.runAction(internal.deals.plan.normalizeLocation, {
          raw: inputs.location,
        });
        if (metro !== null) {
          const plan = await ctx.runAction(
            internal.deals.plan.planForLocation,
            { city: metro.city, state: metro.state },
          );
          planQueries = plan.queries;
          cityDomains = plan.targetUrls;

          // Each store the chain map could not answer is resolved and cached
          // on its own, so one person's write-in no longer decides what
          // everyone else in the city gets.
          for (const store of vague.slice(0, MAX_STORE_PLANS_PER_RUN)) {
            const resolved = await ctx.runAction(
              internal.deals.plan.planForStore,
              { city: metro.city, state: metro.state, store },
            );
            storeDomains = [...storeDomains, ...resolved];
          }
        }
      }

      // Order is the priority the cap enforces: the chains they ticked, then
      // the stores they named, and only then whatever the planner suggested for
      // the city. Appending store plans last would let speculative merchants
      // crowd out the shop the user actually asked for.
      const wanted = [
        ...new Set([...domains, ...storeDomains, ...cityDomains]),
      ];
      counts.merchants = wanted.length;

      const targets = wanted.slice(0, MAX_MERCHANTS_PER_RUN);
      skipped = wanted.slice(MAX_MERCHANTS_PER_RUN);

      const query =
        planQueries[0] ?? "weekly ad grocery deals this week prices";

      const fromChains = new Set(domains);

      for (const domain of targets) {
        // The merchant row is created before the search, not after, so its
        // lastScrapedAt can be consulted while there is still a call to save.
        // Only a domain from the chain map is claimed as "static"; plan-derived
        // merchants already have rows carrying their real source, and
        // upsertMerchant leaves an existing source alone.
        const merchantId = await ctx.runMutation(
          internal.deals.data.upsertMerchant,
          {
            name: domain,
            domain,
            kind: "grocery",
            source: fromChains.has(domain) ? "static" : "codex",
            now,
          },
        );
        if (merchantId === null) continue;

        // A weekly ad does not change twice in a day, and one measured
        // searchDeals call costs 12 Firecrawl credits out of a 1,000/month
        // allowance — so skipping a fresh merchant is the single largest saving
        // in this pipeline.
        const stale = await ctx.runQuery(
          internal.deals.data.merchantsNeedingScrape,
          { merchantIds: [merchantId], now },
        );
        if (stale.length === 0) {
          counts.merchantsFresh += 1;
          continue;
        }

        const pages = await ctx.runAction(api.firecrawl.searchDeals, {
          query,
          includeDomains: [domain],
          limit: SEARCH_RESULTS_PER_MERCHANT,
          maxAgeMs: FIRECRAWL_MAX_AGE_MS,
        });

        counts.scraped += 1;

        for (const page of pages) {
          if (page.coupons.length === 0) continue;

          // A merchant a model proposed has to prove it serves this metro. A
          // chain does not: its ad pages often name no city, and the domain is
          // already the guarantee. Without this, the right brand's store in
          // another city yields a current, well-formed page whose prices are
          // simply wrong for this user.
          if (!fromChains.has(domain) && metro !== null) {
            const evidence = [
              page.url,
              page.title ?? "",
              ...page.coupons.map((c: ExtractedCoupon) => c.title),
              ...page.coupons.map((c: ExtractedCoupon) => c.details ?? ""),
            ].join(" ");
            if (!matchesMetro(evidence, metro)) {
              counts.offMetroDropped += page.coupons.length;
              continue;
            }
          }
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
