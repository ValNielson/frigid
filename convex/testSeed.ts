import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { SCHEMA_VERSION } from "./onboardingQuestions";

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
