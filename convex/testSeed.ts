import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { SCHEMA_VERSION } from "./onboardingQuestions";
import { SESSION_TTL_MS } from "./hash";

/**
 * Seed helpers for exercising the pipeline against the dev deployment.
 *
 * Internal only, so nothing here is reachable from a client. It exists because
 * the parts of this system worth checking — that a run caps merchants, that an
 * allergen is withheld from real scraped data, that two people in one city no
 * longer share each other's store plans — need a profile to run against, and a
 * throwaway file has now been written three times.
 *
 * Writes the same shape preferences.save would, including the pre-built
 * promptContext, so a seeded profile is indistinguishable from an onboarded one
 * to everything downstream.
 */

export const seedUser = internalMutation({
  args: {
    email: v.string(),
    location: v.string(),
    stores: v.array(v.string()),
    allergies: v.array(v.string()),
    promptContext: v.optional(v.string()),
    emailFrequency: v.optional(v.string()),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const frequency = args.emailFrequency ?? "Once a week";

    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();

    const userId =
      existing?._id ??
      (await ctx.db.insert("users", {
        email: args.email,
        verifiedAt: now,
        onboardedAt: now,
        emailFrequency: frequency,
        subscribed: true,
        unsubscribeToken: `seed-${args.email}`,
        attemptsRemaining: 5,
        sendsInWindow: 0,
        windowStartedAt: now,
      }));

    if (existing !== null) {
      await ctx.db.patch(userId, {
        onboardedAt: existing.onboardedAt ?? now,
        emailFrequency: frequency,
      });
    }

    const answers = {
      emailFrequency: { choices: [frequency] },
      // A text question stores its answer in `other`, which is how the wizard
      // and the validating mutation both treat it.
      location: { choices: [], other: args.location },
      stores: { choices: args.stores },
      allergies: { choices: args.allergies },
    };

    const row = {
      userId,
      schemaVersion: SCHEMA_VERSION,
      answers,
      summaryText: "Seeded profile",
      promptContext:
        args.promptContext ??
        `Located in ${args.location}. Shops at ${args.stores.join(", ")}.`,
      completedAt: now,
      updatedAt: now,
    };

    const preferences = await ctx.db
      .query("preferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (preferences === null) await ctx.db.insert("preferences", row);
    else await ctx.db.patch(preferences._id, row);

    return userId;
  },
});

/**
 * Mints a session for a seeded user, so an end-to-end check can drive the real
 * public API instead of reaching past it into internal functions.
 *
 * Takes the hash rather than computing it: this file runs in the deterministic
 * runtime, and the same rule that keeps verification.ts in "use node" applies —
 * secrets are hashed by the caller and arrive here already opaque.
 */
export const seedSession = internalMutation({
  args: { email: v.string(), tokenHash: v.string() },
  returns: v.union(v.id("sessions"), v.null()),
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    if (user === null) return null;

    const now = Date.now();
    return await ctx.db.insert("sessions", {
      userId: user._id,
      tokenHash: args.tokenHash,
      expiresAt: now + SESSION_TTL_MS,
      createdAt: now,
      lastSeenAt: now,
    });
  },
});

/** Clears cached plans so a planner change can be observed rather than assumed. */
export const clearPlans = internalMutation({
  args: {},
  returns: v.object({ dealPlans: v.number(), storePlans: v.number() }),
  handler: async (ctx) => {
    const plans = await ctx.db.query("dealPlans").take(200);
    for (const row of plans) await ctx.db.delete(row._id);

    const stores = await ctx.db.query("storePlans").take(200);
    for (const row of stores) await ctx.db.delete(row._id);

    return { dealPlans: plans.length, storePlans: stores.length };
  },
});

/** What a run produced, for checking caps, drops, and cache behaviour. */
export const inspect = internalMutation({
  args: { userId: v.optional(v.id("users")) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const plans = await ctx.db.query("dealPlans").take(50);
    const stores = await ctx.db.query("storePlans").take(50);
    const merchants = await ctx.db.query("merchants").take(100);

    const run =
      args.userId === undefined
        ? null
        : await ctx.db
            .query("runs")
            .withIndex("by_user", (q) => q.eq("userId", args.userId!))
            .order("desc")
            .first();

    return {
      dealPlans: plans.map((p) => ({
        locationKey: p.locationKey,
        targetUrls: p.targetUrls,
        createdAt: p.createdAt,
      })),
      storePlans: stores.map((s) => ({
        locationKey: s.locationKey,
        storeKey: s.storeKey,
        domains: s.domains,
        createdAt: s.createdAt,
      })),
      merchants: merchants.map((m) => ({
        domain: m.domain,
        source: m.source,
        city: m.city,
      })),
      run:
        run === null
          ? null
          : {
              status: run.status,
              counts: run.counts,
              skippedMerchants: run.skippedMerchants,
              error: run.error,
            },
    };
  },
});

/**
 * Deletes every coupon. Local only — this is how a metro-scoping change gets a
 * clean pool to be judged against, since the pre-existing rows carry dedupe
 * keys from before the metro was part of them.
 */
export const clearCoupons = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("coupons").take(1000);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});

/**
 * Clears this user's recipe jobs so the daily cap does not block a retry during
 * testing. Local only — the cap itself stays enforced in code rather than being
 * raised for convenience.
 */
export const clearJobs = internalMutation({
  args: { email: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    if (user === null) return 0;

    const jobs = await ctx.db
      .query("recipeJobs")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(200);
    for (const job of jobs) await ctx.db.delete(job._id);
    return jobs.length;
  },
});

/**
 * Clears the shared credit ledger. Local only.
 *
 * The daily budget is deliberately hard to get around — that is the point of it
 * — so a day of testing eventually blocks its own next run. Resetting the
 * ledger is honest for a dev deployment and dishonest anywhere else: the credits
 * were really spent, and only the account balance knows it.
 */
export const clearLedger = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("creditLedger").take(1000);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});
