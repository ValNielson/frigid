import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { NO_ALLERGIES } from "../onboardingQuestions";
import { creditsSpentToday, hasBudgetLeft } from "../credits";
import { MANUAL_RUN_COOLDOWN_MS } from "./policy";
import {
  MAILABLE_FREQUENCIES,
  MAX_COUPON_POOL,
  isPlanFresh,
  storePlanKey,
  couponDedupeKey,
  isDigestDue,
  isScrapeFresh,
  normalizeDomain,
  rawLocationKey,
} from "./policy";

/**
 * Internal data layer for coupon discovery.
 *
 * Everything here runs in Convex's default (deterministic) runtime, so it holds
 * no SDK calls and no clock of its own — `now` arrives from the action that
 * already has one. The actions in this directory own the network; this file
 * owns the tables.
 */

const couponInput = v.object({
  title: v.string(),
  details: v.optional(v.string()),
  code: v.optional(v.string()),
  discount: v.optional(v.string()),
  primaryItem: v.optional(v.string()),
  itemTerms: v.array(v.string()),
  tags: v.array(v.string()),
  expiresAt: v.optional(v.number()),
  sourceKind: v.string(),
  sourceUrl: v.optional(v.string()),
  messageId: v.optional(v.string()),
});

const couponOutput = v.object({
  _id: v.id("coupons"),
  merchantId: v.id("merchants"),
  title: v.string(),
  details: v.optional(v.string()),
  code: v.optional(v.string()),
  discount: v.optional(v.string()),
  primaryItem: v.optional(v.string()),
  itemTerms: v.array(v.string()),
  tags: v.array(v.string()),
  expiresAt: v.optional(v.number()),
  sourceUrl: v.optional(v.string()),
});

/**
 * Creates or refreshes a merchant, keyed on domain.
 *
 * Shared across users on purpose: two people who both shop at Meijer point at
 * one row, so scraping it once serves both. Fields are only overwritten when
 * the caller has something better than what is stored, which keeps a plain
 * search result from blanking a deals URL an earlier run worked out.
 */
export const upsertMerchant = internalMutation({
  args: {
    name: v.string(),
    domain: v.string(),
    dealsUrl: v.optional(v.string()),
    signupUrl: v.optional(v.string()),
    city: v.optional(v.string()),
    kind: v.string(),
    source: v.string(),
    now: v.number(),
  },
  returns: v.union(v.id("merchants"), v.null()),
  handler: async (ctx, args) => {
    const domain = normalizeDomain(args.domain);
    if (domain === null) return null;

    const existing = await ctx.db
      .query("merchants")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .unique();

    if (existing === null) {
      return await ctx.db.insert("merchants", {
        name: args.name,
        domain,
        dealsUrl: args.dealsUrl,
        signupUrl: args.signupUrl,
        city: args.city,
        kind: args.kind,
        source: args.source,
        discoveredAt: args.now,
      });
    }

    await ctx.db.patch(existing._id, {
      dealsUrl: args.dealsUrl ?? existing.dealsUrl,
      signupUrl: args.signupUrl ?? existing.signupUrl,
      city: args.city ?? existing.city,
    });
    return existing._id;
  },
});

/** Resolves store domains to merchant rows, skipping any we have never seen. */
export const merchantsByDomains = internalQuery({
  args: { domains: v.array(v.string()) },
  returns: v.array(
    v.object({
      _id: v.id("merchants"),
      name: v.string(),
      domain: v.string(),
      dealsUrl: v.optional(v.string()),
      lastScrapedAt: v.optional(v.number()),
      source: v.string(),
      city: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const found = [];
    for (const raw of args.domains) {
      const domain = normalizeDomain(raw);
      if (domain === null) continue;
      const row = await ctx.db
        .query("merchants")
        .withIndex("by_domain", (q) => q.eq("domain", domain))
        .unique();
      if (row === null) continue;
      found.push({
        _id: row._id,
        name: row.name,
        domain: row.domain,
        dealsUrl: row.dealsUrl,
        lastScrapedAt: row.lastScrapedAt,
        source: row.source,
        city: row.city,
      });
    }
    return found;
  },
});

/**
 * Which of these merchants are stale enough to be worth fetching again.
 *
 * Returns the name alongside the id because the caller needs it to build that
 * merchant's search query, and it is already holding the row.
 */
export const merchantsNeedingScrape = internalQuery({
  args: {
    merchantIds: v.array(v.id("merchants")),
    metroKey: v.string(),
    now: v.number(),
  },
  returns: v.array(v.object({ _id: v.id("merchants"), name: v.string() })),
  handler: async (ctx, args) => {
    const stale = [];
    for (const id of args.merchantIds) {
      const row = await ctx.db.get(id);
      if (row === null) continue;
      // Per metro, not per domain. Kroger being fresh for Grand Rapids says
      // nothing about whether we have ever read its Cleveland ad.
      const scrape = await ctx.db
        .query("merchantScrapes")
        .withIndex("by_merchant_metro", (q) =>
          q.eq("merchantId", id).eq("metroKey", args.metroKey),
        )
        .unique();
      if (!isScrapeFresh(scrape?.lastScrapedAt, args.now)) {
        stale.push({ _id: row._id, name: row.name });
      }
    }
    return stale;
  },
});

/** Store names for a set of coupons, so a deal can say where to buy it. */
export const merchantNamesByIds = internalQuery({
  args: { merchantIds: v.array(v.id("merchants")) },
  returns: v.array(v.object({ _id: v.id("merchants"), name: v.string() })),
  handler: async (ctx, args) => {
    const found = [];
    for (const id of [...new Set(args.merchantIds)]) {
      const row = await ctx.db.get(id);
      if (row !== null) found.push({ _id: row._id, name: row.name });
    }
    return found;
  },
});

export const markScraped = internalMutation({
  args: {
    merchantId: v.id("merchants"),
    metroKey: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("merchantScrapes")
      .withIndex("by_merchant_metro", (q) =>
        q.eq("merchantId", args.merchantId).eq("metroKey", args.metroKey),
      )
      .unique();

    if (existing === null) {
      await ctx.db.insert("merchantScrapes", {
        merchantId: args.merchantId,
        metroKey: args.metroKey,
        lastScrapedAt: args.now,
      });
    } else {
      await ctx.db.patch(existing._id, { lastScrapedAt: args.now });
    }

    // Still written so the merchant row shows when it was last read at all.
    await ctx.db.patch(args.merchantId, { lastScrapedAt: args.now });
    return null;
  },
});

/**
 * Writes a batch of coupons, replacing any row with the same dedupe key.
 *
 * Returns how many were new, which is what distinguishes "the ad has not
 * changed since yesterday" from "the scrape came back empty" on the runs row.
 */
export const upsertCoupons = internalMutation({
  args: {
    merchantId: v.id("merchants"),
    domain: v.string(),
    metroKey: v.string(),
    userId: v.union(v.id("users"), v.null()),
    coupons: v.array(couponInput),
    now: v.number(),
  },
  returns: v.object({ inserted: v.number(), updated: v.number() }),
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;

    for (const coupon of args.coupons) {
      const dedupeKey = couponDedupeKey(
        args.metroKey,
        args.domain,
        coupon.title,
        coupon.code,
      );
      const existing = await ctx.db
        .query("coupons")
        .withIndex("by_dedupe_key", (q) => q.eq("dedupeKey", dedupeKey))
        .unique();

      const row = {
        userId: args.userId,
        merchantId: args.merchantId,
        ...coupon,
        metroKey: args.metroKey,
        itemTerms: coupon.itemTerms.map((term) => term.toLowerCase()),
        dedupeKey,
        foundAt: args.now,
      };

      if (existing === null) {
        await ctx.db.insert("coupons", row);
        inserted += 1;
      } else {
        await ctx.db.patch(existing._id, row);
        updated += 1;
      }
    }

    return { inserted, updated };
  },
});

/**
 * Unexpired coupons this user may see: everything scraped from a public page,
 * plus anything mined from their own mail. Filtering by taste happens after
 * this, in the action that has the profile.
 */
export const couponsForUser = internalQuery({
  args: {
    userId: v.id("users"),
    merchantIds: v.array(v.id("merchants")),
    metroKey: v.string(),
    now: v.number(),
  },
  returns: v.array(couponOutput),
  handler: async (ctx, args) => {
    const wanted = new Set(args.merchantIds);
    const seen = new Set<string>();
    const results = [];

    // Newest first, explicitly. Convex defaults to ascending, so without this
    // the pool froze on the oldest MAX_COUPON_POOL rows and every coupon
    // scraped after that point was paid for and never read.
    const pools = [
      await ctx.db
        .query("coupons")
        .withIndex("by_user", (q) => q.eq("userId", null))
        .order("desc")
        .take(MAX_COUPON_POOL),
      await ctx.db
        .query("coupons")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .order("desc")
        .take(MAX_COUPON_POOL),
    ];

    for (const pool of pools) {
      for (const row of pool) {
        if (seen.has(row.dedupeKey)) continue;
        if (row.expiresAt !== undefined && row.expiresAt < args.now) continue;
        // Mail-sourced coupons are kept even from a merchant the user did not
        // list, and regardless of metro: they only arrive because this person
        // signed up for that list, so they are already theirs.
        if (row.sourceKind === "scrape") {
          if (!wanted.has(row.merchantId)) continue;
          // A chain's weekly ad is regional. Without this a Grand Rapids price
          // was shown to a Cleveland shopper — and, worse, made their pool look
          // warm so their own city was never scraped.
          if (row.metroKey !== args.metroKey) continue;
        }
        seen.add(row.dedupeKey);
        results.push({
          _id: row._id,
          merchantId: row.merchantId,
          title: row.title,
          details: row.details,
          code: row.code,
          discount: row.discount,
          primaryItem: row.primaryItem,
          itemTerms: row.itemTerms,
          tags: row.tags,
          expiresAt: row.expiresAt,
          sourceUrl: row.sourceUrl,
        });
      }
    }

    return results;
  },
});

/** The cached normalization of a raw onboarding location answer. */
export const getLocation = internalQuery({
  args: { raw: v.string() },
  returns: v.union(
    v.object({
      city: v.string(),
      state: v.optional(v.string()),
      zip: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("locations")
      .withIndex("by_raw", (q) => q.eq("raw", rawLocationKey(args.raw)))
      .unique();
    if (row === null) return null;
    return { city: row.city, state: row.state, zip: row.zip };
  },
});

export const saveLocation = internalMutation({
  args: {
    raw: v.string(),
    city: v.string(),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const raw = rawLocationKey(args.raw);
    const existing = await ctx.db
      .query("locations")
      .withIndex("by_raw", (q) => q.eq("raw", raw))
      .unique();
    if (existing !== null) return null;

    await ctx.db.insert("locations", {
      raw,
      city: args.city,
      state: args.state,
      zip: args.zip,
      normalizedAt: args.now,
    });
    return null;
  },
});

export const getPlan = internalQuery({
  args: { locationKey: v.string(), now: v.number() },
  returns: v.union(
    v.object({ queries: v.array(v.string()), targetUrls: v.array(v.string()) }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("dealPlans")
      .withIndex("by_location_key", (q) =>
        q.eq("locationKey", args.locationKey),
      )
      .unique();
    if (row === null) return null;
    // Expiry is enforced here rather than by a sweeper, so a stale plan simply
    // reads as absent and the next run replaces it.
    if (!isPlanFresh(row.createdAt, args.now)) return null;
    return { queries: row.queries, targetUrls: row.targetUrls };
  },
});

export const savePlan = internalMutation({
  args: {
    locationKey: v.string(),
    queries: v.array(v.string()),
    targetUrls: v.array(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("dealPlans")
      .withIndex("by_location_key", (q) =>
        q.eq("locationKey", args.locationKey),
      )
      .unique();

    if (existing === null) {
      await ctx.db.insert("dealPlans", {
        locationKey: args.locationKey,
        queries: args.queries,
        targetUrls: args.targetUrls,
        createdAt: args.now,
      });
    } else {
      await ctx.db.patch(existing._id, {
        queries: args.queries,
        targetUrls: args.targetUrls,
        createdAt: args.now,
      });
    }
    return null;
  },
});

/**
 * Whether this person may start a run right now, and why not.
 *
 * One query rather than a helper per caller: the two public mutations and the
 * recipe pipeline's deals step all have to agree, and they previously did not —
 * requestRun enforced the cooldown, findForIngredients enforced nothing. A
 * query rather than a plain function so an action can read it too, which is
 * what the recipe step needs.
 */
export const runBlocked = internalQuery({
  args: { userId: v.id("users"), now: v.number() },
  returns: v.union(
    v.object({
      error: v.string(),
      cooldownSeconds: v.optional(v.number()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const recent = await ctx.db
      .query("runs")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .order("desc")
      .first();

    // Throttled on the server, not the button: a run costs real Firecrawl and
    // model spend, and a disabled button is a suggestion.
    if (recent !== null && args.now - recent.startedAt < MANUAL_RUN_COOLDOWN_MS) {
      const remaining = MANUAL_RUN_COOLDOWN_MS - (args.now - recent.startedAt);
      return {
        error: "We are still working on your last request.",
        cooldownSeconds: Math.ceil(remaining / 1000),
      };
    }

    // The same shared ledger recipeJobs.start reads. Coupon discovery is the
    // heavier of the two pipelines, so leaving it unmetered made the brake
    // decorative.
    if (!hasBudgetLeft(await creditsSpentToday(ctx, args.now))) {
      return { error: "We've hit today's search budget. Try again tomorrow." };
    }

    return null;
  },
});

export const startRun = internalMutation({
  args: {
    userId: v.id("users"),
    kind: v.string(),
    trigger: v.string(),
    now: v.number(),
  },
  returns: v.id("runs"),
  handler: async (ctx, args) => {
    // Stamped at the start, not on a successful send. A cron run that matched
    // nothing sends no mail, and keying the cadence on sends alone left those
    // users permanently due — re-run every day whatever cadence they chose.
    // Stamping here also means a run that crashes cannot retry forever.
    if (args.trigger === "cron") {
      await ctx.db.patch(args.userId, { lastDigestAttemptAt: args.now });
    }

    return await ctx.db.insert("runs", {
      userId: args.userId,
      kind: args.kind,
      status: "running",
      trigger: args.trigger,
      startedAt: args.now,
      updatedAt: args.now,
      counts: {
        merchants: 0,
        scraped: 0,
        couponsFound: 0,
        couponsMatched: 0,
        offMetroDropped: 0,
        merchantsFresh: 0,
      },
    });
  },
});

export const finishRun = internalMutation({
  args: {
    runId: v.id("runs"),
    status: v.string(),
    counts: v.object({
      merchants: v.number(),
      scraped: v.number(),
      couponsFound: v.number(),
      couponsMatched: v.number(),
      offMetroDropped: v.optional(v.number()),
      // Merchants skipped because their last scrape is still inside the TTL.
      // The saving is the point: each skip is a Firecrawl call not made.
      merchantsFresh: v.optional(v.number()),
    }),
    skippedMerchants: v.optional(v.array(v.string())),
    error: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: args.status,
      counts: args.counts,
      skippedMerchants: args.skippedMerchants,
      error: args.error,
      updatedAt: args.now,
      finishedAt: args.now,
    });
    return null;
  },
});

/**
 * Says where a running chain has got to, without moving it out of its step.
 *
 * Deliberately cannot write `status`: the only writers of that are startRun and
 * finishRun, and a progress note that could knock a run into another state would
 * be a second source of truth for the same field. The timestamp is half the
 * point — it is what latestRun measures a stall against.
 */
export const markRunStatus = internalMutation({
  args: {
    runId: v.id("runs"),
    statusDetail: v.string(),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      statusDetail: args.statusDetail,
      updatedAt: args.now,
    });
    return null;
  },
});

/**
 * Who the daily cron should mail right now.
 *
 * Walks by_email_frequency once per mailable cadence rather than reading every
 * user, which is what the denormalized column on users is for. "Only when I
 * ask" is not in MAILABLE_FREQUENCIES, so the opt-out is enforced by never
 * looking those rows up, and isDigestDue re-checks it anyway.
 */
export const usersDueForDigest = internalQuery({
  args: { now: v.number() },
  returns: v.array(v.id("users")),
  handler: async (ctx, args) => {
    const due = [];

    for (const frequency of MAILABLE_FREQUENCIES) {
      const rows = await ctx.db
        .query("users")
        .withIndex("by_email_frequency", (q) =>
          q.eq("emailFrequency", frequency),
        )
        .collect();

      for (const row of rows) {
        if (!row.subscribed) continue;
        if (row.onboardedAt === undefined) continue;
        // The later of "we sent" and "we tried". isDigestDue stays a pure
        // function of one timestamp; picking which one is this caller's job.
        const lastTouched = Math.max(
          row.lastDigestAt ?? 0,
          row.lastDigestAttemptAt ?? 0,
        );
        if (
          !isDigestDue(
            row.emailFrequency,
            lastTouched === 0 ? undefined : lastTouched,
            args.now,
          )
        ) {
          continue;
        }
        due.push(row._id);
      }
    }

    return due;
  },
});

export const markDigestSent = internalMutation({
  args: { userId: v.id("users"), now: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, { lastDigestAt: args.now });
    return null;
  },
});

/**
 * Everything a run needs about one person, in a single read.
 *
 * Pulls the three onboarding answers the pipeline acts on plus the pre-built
 * promptContext, so the action never re-derives a profile from 21 raw answers.
 */
export const runInputs = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(
    v.object({
      email: v.string(),
      unsubscribeToken: v.string(),
      subscribed: v.boolean(),
      location: v.string(),
      stores: v.array(v.string()),
      allergies: v.array(v.string()),
      promptContext: v.string(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (user === null) return null;

    const preferences = await ctx.db
      .query("preferences")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (preferences === null) return null;

    const answers = preferences.answers;
    const answer = (id: string) => answers[id];

    // Allergies and stores both allow a write-in, and the free text is as
    // binding as a checkbox — an allergy typed rather than picked still has to
    // filter, so `other` is folded in alongside the choices.
    const withOther = (id: string) => {
      const row = answer(id);
      if (row === undefined) return [];
      const other = row.other?.trim();
      return other === undefined || other.length === 0
        ? [...row.choices]
        : [...row.choices, other];
    };

    return {
      email: user.email,
      unsubscribeToken: user.unsubscribeToken,
      subscribed: user.subscribed,
      location: answer("location")?.other?.trim() ?? "",
      stores: withOther("stores"),
      // The explicit "no allergies" opt-out is an answer, not an allergen, and
      // passing it through would leave a nonsense term in the filter.
      allergies: withOther("allergies").filter(
        (entry) => entry !== NO_ALLERGIES,
      ),
      promptContext: preferences.promptContext,
    };
  },
});

/** A write-in store's resolved domains in one city, if still fresh. */
export const getStorePlan = internalQuery({
  args: { locationKey: v.string(), store: v.string(), now: v.number() },
  returns: v.union(v.array(v.string()), v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("storePlans")
      .withIndex("by_location_store", (q) =>
        q
          .eq("locationKey", args.locationKey)
          .eq("storeKey", storePlanKey(args.store)),
      )
      .unique();
    if (row === null) return null;
    if (!isPlanFresh(row.createdAt, args.now)) return null;
    return row.domains;
  },
});

export const saveStorePlan = internalMutation({
  args: {
    locationKey: v.string(),
    store: v.string(),
    domains: v.array(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const storeKey = storePlanKey(args.store);
    const existing = await ctx.db
      .query("storePlans")
      .withIndex("by_location_store", (q) =>
        q.eq("locationKey", args.locationKey).eq("storeKey", storeKey),
      )
      .unique();

    if (existing === null) {
      await ctx.db.insert("storePlans", {
        locationKey: args.locationKey,
        storeKey,
        domains: args.domains,
        createdAt: args.now,
      });
    } else {
      await ctx.db.patch(existing._id, {
        domains: args.domains,
        createdAt: args.now,
      });
    }
    return null;
  },
});
