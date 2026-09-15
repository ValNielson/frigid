"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { GenericActionCtx } from "convex/server";
import type { DataModel, Id } from "../_generated/dataModel";
import {
  FIRECRAWL_MAX_AGE_MS,
  MAX_MERCHANTS_PER_RUN,
  MAX_MERCHANT_ATTEMPTS,
  MAX_STORE_PLANS_PER_RUN,
  RATE_LIMIT_BACKOFF_MS,
  SEARCH_RESULTS_PER_MERCHANT,
  matchIngredients,
  matchesMetro,
  merchantSearchQuery,
  locationKey,
  splitStores,
} from "./policy";
import { MAX_DEALS_PER_JOB } from "../recipePolicy";
import { RATE_LIMIT_SKIPPED } from "../firecrawlClient";

/**
 * Finding deals, as a chain of scheduled steps: plan, then one merchant per
 * step, then finish.
 *
 * It was a single action holding the whole run. That could not survive the
 * request limiter: a cold city spends its per-minute budget on discovery, and
 * every merchant afterwards then had to either sleep — inside an action with a
 * finite budget — or be skipped. A live San Diego run skipped all nine.
 *
 * One merchant per step fixes that structurally. Each step is short, the
 * rolling window drains between them, and a merchant the limiter turns away is
 * rescheduled rather than abandoned. The product already tells people their
 * results arrive by email, so taking minutes is a cost it can pay.
 *
 * Every stage is still bounded. Merchants per run are capped and the ones
 * dropped are recorded, so a truncated run cannot be mistaken for full coverage.
 */

type ExtractedCoupon = {
  title: string;
  details?: string;
  code?: string;
  discount?: string;
  primaryItem?: string;
  itemTerms?: string[];
  expiresAt?: string;
};

type SelectedPick = { coupon: Candidate; reason: string };

const metroValidator = v.union(
  v.object({
    city: v.string(),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
  }),
  v.null(),
);

const countsValidator = v.object({
  merchants: v.number(),
  scraped: v.number(),
  couponsFound: v.number(),
  couponsMatched: v.number(),
  offMetroDropped: v.number(),
  merchantsFresh: v.number(),
});

/**
 * Everything the later steps need, passed along rather than re-derived.
 *
 * Explicit rather than stashed on the run row: the steps are a pipeline, and a
 * pipeline that reads its inputs back out of a table is one where a schema
 * change silently breaks a step nobody is looking at.
 */
const stateValidator = v.object({
  runId: v.id("runs"),
  userId: v.id("users"),
  ingredients: v.optional(v.array(v.string())),
  sendEmail: v.optional(v.boolean()),
  recipeJobId: v.optional(v.id("recipeJobs")),
  wanted: v.array(v.string()),
  targets: v.array(v.string()),
  skipped: v.array(v.string()),
  chainDomains: v.array(v.string()),
  metro: metroValidator,
  metroKey: v.string(),
  place: v.union(v.string(), v.null()),
  fallbackQuery: v.string(),
  counts: countsValidator,
});

type RunState = {
  runId: Id<"runs">;
  userId: Id<"users">;
  ingredients?: string[];
  sendEmail?: boolean;
  recipeJobId?: Id<"recipeJobs">;
  wanted: string[];
  targets: string[];
  skipped: string[];
  chainDomains: string[];
  metro: { city: string; state?: string; zip?: string } | null;
  metroKey: string;
  place: string | null;
  fallbackQuery: string;
  counts: {
    merchants: number;
    scraped: number;
    couponsFound: number;
    couponsMatched: number;
    offMetroDropped: number;
    merchantsFresh: number;
  };
};

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
    // Created by the caller, not here. The manual cooldown reads the runs table,
    // and a row written only once this action starts left a window where two
    // clicks in a row both passed the guard and both paid.
    runId: v.id("runs"),
    trigger: v.string(),
    ingredients: v.optional(v.array(v.string())),
    sendEmail: v.optional(v.boolean()),
    // Set when a recipe job is waiting on this run. Its picks are written back
    // onto that job and the job's email is released at the end, which is what
    // lets a cold city still send an email that carries deals.
    recipeJobId: v.optional(v.id("recipeJobs")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const counts = {
      merchants: 0,
      scraped: 0,
      couponsFound: 0,
      couponsMatched: 0,
      offMetroDropped: 0,
      merchantsFresh: 0,
    };

    try {
      // Checked here and not only at the public mutations, because the cron
      // reaches this action directly. A single run is up to five merchants at
      // twelve credits each against a thousand-a-month allowance, so an
      // unmetered cron path is the most expensive hole there is.
      if (!(await ctx.runQuery(internal.credits.withinBudget, { now }))) {
        await ctx.runMutation(internal.deals.data.finishRun, {
          runId: args.runId,
          status: "skipped",
          counts,
          error: "Daily Firecrawl budget reached",
          now: Date.now(),
        });
        await releaseRecipeJob(ctx, args.recipeJobId);
        return null;
      }

      const inputs = await ctx.runQuery(internal.deals.data.runInputs, {
        userId: args.userId,
      });
      if (inputs === null) throw new Error("No profile for this user yet");

      const { domains, vague } = splitStores(inputs.stores);

      // Planning a city nobody has asked about is several model calls and
      // several site lookups, all of them paced. That is the longest stretch
      // where nothing else would touch the job.
      await heartbeat(ctx, args.runId, args.recipeJobId, "Finding stores near you");

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
      const wanted = [...new Set([...domains, ...storeDomains, ...cityDomains])];
      counts.merchants = wanted.length;

      const state: RunState = {
        runId: args.runId,
        userId: args.userId,
        ...(args.ingredients !== undefined ? { ingredients: args.ingredients } : {}),
        ...(args.sendEmail !== undefined ? { sendEmail: args.sendEmail } : {}),
        ...(args.recipeJobId !== undefined ? { recipeJobId: args.recipeJobId } : {}),
        wanted,
        targets: wanted.slice(0, MAX_MERCHANTS_PER_RUN),
        skipped: wanted.slice(MAX_MERCHANTS_PER_RUN),
        chainDomains: [...domains],
        metro,
        // Everything stored by this run is stamped with it, and everything read
        // back is filtered by it. "" when the user gave no location: those runs
        // can still scrape their named chains, they just form their own bucket.
        metroKey: metro === null ? "" : locationKey(metro.city, metro.state),
        place:
          metro === null
            ? null
            : metro.state === undefined
              ? metro.city
              : `${metro.city}, ${metro.state}`,
        // The fallback only. Each merchant gets its own query, because
        // searching a butcher for "grocery weekly ads" is how a live run
        // returns nothing and still bills for the attempt.
        fallbackQuery: planQueries[0] ?? "weekly ad grocery deals this week prices",
        counts,
      };

      await heartbeat(
        ctx,
        args.runId,
        args.recipeJobId,
        `Checking ${state.targets.length} ${state.targets.length === 1 ? "store" : "stores"} near you`,
      );

      // Handed to the scheduler rather than looped here. Discovery above has
      // just spent most of the per-minute request budget; a merchant asking for
      // one now would be turned away, and each step gives the window time to
      // drain.
      await ctx.scheduler.runAfter(0, internal.deals.run.scrapeMerchant, {
        state,
        index: 0,
        attempt: 1,
      });
    } catch (error) {
      await ctx.runMutation(internal.deals.data.finishRun, {
        runId: args.runId,
        status: "failed",
        counts,
        error: error instanceof Error ? error.message : String(error),
        now: Date.now(),
      });
      await releaseRecipeJob(ctx, args.recipeJobId);
    }

    return null;
  },
});

/**
 * Reads one merchant, then hands the next to the scheduler.
 *
 * One per step on purpose. The limiter allows eight requests a minute across
 * both pipelines, and a merchant search costs three of them; a loop that held
 * all five would spend its life asleep or be refused outright.
 */
export const scrapeMerchant = internalAction({
  args: {
    state: stateValidator,
    index: v.number(),
    // Counted per merchant, not per run: the limiter turning one away says
    // nothing about the next.
    attempt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state: RunState = { ...args.state };
    const domain = state.targets[args.index];

    if (domain === undefined) {
      await ctx.scheduler.runAfter(0, internal.deals.run.finalize, { state });
      return null;
    }

    await heartbeat(
      ctx,
      state.runId,
      state.recipeJobId,
      `Checking ${domain} (${args.index + 1} of ${state.targets.length})`,
    );

    const next = async (updated: RunState, delayMs = 0) => {
      await ctx.scheduler.runAfter(delayMs, internal.deals.run.scrapeMerchant, {
        state: updated,
        index: args.index + 1,
        attempt: 1,
      });
    };

    try {
      const now = Date.now();

      // Re-read rather than trusting the check when the run started: each step
      // spends twelve credits, and the gap between the first merchant and the
      // last is wide enough for another run to have emptied the budget.
      if (!(await ctx.runQuery(internal.credits.withinBudget, { now }))) {
        await ctx.scheduler.runAfter(0, internal.deals.run.finalize, {
          state: {
            ...state,
            skipped: [...state.skipped, ...state.targets.slice(args.index)],
          },
        });
        return null;
      }

      // The merchant row is created before the search, not after, so its
      // freshness can be consulted while there is still a call to save. Only a
      // domain from the chain map is claimed as "static"; plan-derived
      // merchants already have rows carrying their real source, and
      // upsertMerchant leaves an existing source alone.
      const merchantId = await ctx.runMutation(
        internal.deals.data.upsertMerchant,
        {
          name: domain,
          domain,
          kind: "grocery",
          source: state.chainDomains.includes(domain) ? "static" : "codex",
          now,
        },
      );
      if (merchantId === null) return await next(state);

      // A weekly ad does not change twice in a day, and one measured
      // searchDeals call costs 12 Firecrawl credits out of a 1,000/month
      // allowance — so skipping a fresh merchant is the single largest saving
      // in this pipeline.
      const stale = await ctx.runQuery(
        internal.deals.data.merchantsNeedingScrape,
        { merchantIds: [merchantId], metroKey: state.metroKey, now },
      );
      if (stale.length === 0) {
        return await next({
          ...state,
          counts: { ...state.counts, merchantsFresh: state.counts.merchantsFresh + 1 },
        });
      }
      const merchantName = stale[0]?.name ?? domain;

      const pages = await ctx.runAction(internal.firecrawlClient.searchDeals, {
        query: merchantSearchQuery(merchantName, state.place) || state.fallbackQuery,
        includeDomains: [domain],
        limit: SEARCH_RESULTS_PER_MERCHANT,
        maxAgeMs: FIRECRAWL_MAX_AGE_MS,
      });

      const counts = { ...state.counts, scraped: state.counts.scraped + 1 };

      for (const page of pages) {
        if (page.coupons.length === 0) continue;

        // A merchant a model proposed has to prove it serves this metro. A
        // chain does not: its ad pages often name no city, and the domain is
        // already the guarantee. Without this, the right brand's store in
        // another city yields a current, well-formed page whose prices are
        // simply wrong for this user.
        if (!state.chainDomains.includes(domain) && state.metro !== null) {
          const evidence = [
            page.url,
            page.title ?? "",
            ...page.coupons.map((c: ExtractedCoupon) => c.title),
            ...page.coupons.map((c: ExtractedCoupon) => c.details ?? ""),
          ].join(" ");
          if (!matchesMetro(evidence, state.metro)) {
            counts.offMetroDropped += page.coupons.length;
            continue;
          }
        }

        const written = await ctx.runMutation(
          internal.deals.data.upsertCoupons,
          {
            merchantId,
            domain,
            metroKey: state.metroKey,
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
        metroKey: state.metroKey,
        now,
      });

      return await next({ ...state, counts });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Turned away by the limiter rather than broken. Wait for the window to
      // drain and ask again for the same merchant — abandoning it here is what
      // made a live run skip every store it had just planned for.
      if (message.includes(RATE_LIMIT_SKIPPED) && args.attempt < MAX_MERCHANT_ATTEMPTS) {
        await heartbeat(
          ctx,
          state.runId,
          state.recipeJobId,
          `Waiting to check ${domain} (${args.index + 1} of ${state.targets.length})`,
        );
        await ctx.scheduler.runAfter(
          RATE_LIMIT_BACKOFF_MS,
          internal.deals.run.scrapeMerchant,
          { state, index: args.index, attempt: args.attempt + 1 },
        );
        return null;
      }

      // Anything else, or a merchant that has waited long enough: one store
      // failing must not cost the run the stores it already read.
      return await next({ ...state, skipped: [...state.skipped, domain] });
    }
  },
});

/** Matching, the digest, and closing the run out. */
export const finalize = internalAction({
  args: { state: stateValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state: RunState = { ...args.state };
    const counts = { ...state.counts };

    try {
      // Matching is a model call, so this step is not instant either.
      await heartbeat(
        ctx,
        state.runId,
        state.recipeJobId,
        "Picking the deals worth sending",
      );

      const inputs = await ctx.runQuery(internal.deals.data.runInputs, {
        userId: state.userId,
      });
      if (inputs === null) throw new Error("No profile for this user yet");

      const merchants = await ctx.runQuery(
        internal.deals.data.merchantsByDomains,
        { domains: state.wanted },
      );

      let candidates: Candidate[] = await ctx.runQuery(
        internal.deals.data.couponsForUser,
        {
          userId: state.userId,
          merchantIds: merchants.map(
            (merchant: { _id: Id<"merchants"> }) => merchant._id,
          ),
          metroKey: state.metroKey,
          now: Date.now(),
        },
      );

      // An ingredient run narrows to the recipe before the model is asked
      // anything, so a ten-ingredient recipe costs one small call, not ten.
      if (state.ingredients !== undefined) {
        candidates = matchIngredients(candidates, state.ingredients);
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

      // A recipe job waiting on this run gets the picks written onto it and its
      // email released. `ingredients` was already the job's shopping list, so
      // these picks are exactly the deals for that recipe.
      if (state.recipeJobId !== undefined) {
        const names = await ctx.runQuery(
          internal.deals.data.merchantNamesByIds,
          {
            merchantIds: selection.picks.map(
              (pick: SelectedPick) => pick.coupon.merchantId,
            ),
          },
        );
        const nameFor = new Map(
          names.map((row: { _id: Id<"merchants">; name: string }) => [
            row._id,
            row.name,
          ]),
        );

        await ctx.runMutation(internal.recipeJobs.setDeals, {
          jobId: state.recipeJobId,
          deals: selection.picks
            .slice(0, MAX_DEALS_PER_JOB)
            .map((pick: SelectedPick) => ({
              title: pick.coupon.title,
              discount: pick.coupon.discount,
              details: pick.coupon.details,
              code: pick.coupon.code,
              sourceUrl: pick.coupon.sourceUrl,
              merchantName: nameFor.get(pick.coupon.merchantId),
            })),
        });
      }

      if (state.sendEmail !== false && selection.picks.length > 0) {
        await ctx.runAction(internal.deals.digest.send, {
          userId: state.userId,
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
        runId: state.runId,
        status: "done",
        counts,
        skippedMerchants: state.skipped.length > 0 ? state.skipped : undefined,
        now: Date.now(),
      });
    } catch (error) {
      await ctx.runMutation(internal.deals.data.finishRun, {
        runId: state.runId,
        status: "failed",
        counts,
        skippedMerchants: state.skipped.length > 0 ? state.skipped : undefined,
        error: error instanceof Error ? error.message : String(error),
        now: Date.now(),
      });
    }

    // Deals are a bonus; recipes are what the user asked for. Released whatever
    // happened above, or the job sits in "dealing" until the stall threshold
    // and the user never gets their email.
    await releaseRecipeJob(ctx, state.recipeJobId);
    return null;
  },
});

/**
 * Keeps the clocks moving, and says where the run is.
 *
 * The chain is deliberately slow: one merchant per step, paced by the shared
 * request limiter, and nothing else touches these rows while it runs. Without
 * this a perfectly healthy run outlives DEAL_STALL_AFTER_MS and the screen tells
 * the user it stopped responding — which a live San Diego run did for half an
 * hour while it was working.
 *
 * The detail text is the point as much as the timestamp. "Checking kroger.com
 * (2 of 5)" is a truer progress line than a static "checking what is on sale".
 *
 * The run row is always written; the recipe job only when one is waiting. A run
 * started from the prompt or the cron has no job, and reporting its progress
 * against a row that does not exist is why those runs looked stalled from the
 * outside while they were working.
 */
async function heartbeat(
  ctx: GenericActionCtx<DataModel>,
  runId: Id<"runs">,
  recipeJobId: Id<"recipeJobs"> | undefined,
  detail: string,
): Promise<void> {
  await ctx.runMutation(internal.deals.data.markRunStatus, {
    runId,
    statusDetail: detail,
    now: Date.now(),
  });
  if (recipeJobId === undefined) return;
  await ctx.runMutation(internal.recipeJobs.markStatus, {
    jobId: recipeJobId,
    statusDetail: detail,
  });
}

/** Lets a waiting recipe job send its email, deals or not. */
async function releaseRecipeJob(
  ctx: GenericActionCtx<DataModel>,
  recipeJobId: Id<"recipeJobs"> | undefined,
): Promise<void> {
  if (recipeJobId === undefined) return;
  await ctx.scheduler.runAfter(0, internal.recipeRun.email, {
    jobId: recipeJobId,
  });
}

/** A date we can trust, or nothing. */
function parseExpiry(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}
