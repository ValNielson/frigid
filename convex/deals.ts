import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { userForToken } from "./sessions";
import { MANUAL_RUN_COOLDOWN_MS } from "./deals/policy";

/**
 * The public surface for coupon discovery.
 *
 * Everything here resolves a session first, so a run is always attributable to
 * one person, and the work itself is scheduled rather than awaited — a run
 * outlives a single action's request window, which is why the console tells
 * people their results arrive by email.
 */

/**
 * Starts a run for the signed-in user.
 *
 * The prompt text is not sent to a model. What the user types tells us they
 * want deals now; their stored profile decides which ones, and re-deriving that
 * from free text would cost tokens to arrive at an answer we already have.
 */
export const requestRun = mutation({
  args: { sessionToken: v.string(), prompt: v.optional(v.string()) },
  returns: v.object({
    ok: v.boolean(),
    error: v.optional(v.string()),
    cooldownSeconds: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    const user = await userForToken(ctx, args.sessionToken);
    if (user === null) {
      return { ok: false, error: "Please verify your email again." };
    }

    const now = Date.now();
    const recent = await ctx.db
      .query("runs")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .first();

    // Throttled on the server, not the button: a run costs real Firecrawl and
    // model spend, and a disabled button is a suggestion.
    if (recent !== null && now - recent.startedAt < MANUAL_RUN_COOLDOWN_MS) {
      const remaining = MANUAL_RUN_COOLDOWN_MS - (now - recent.startedAt);
      return {
        ok: false,
        error: "We are still working on your last request.",
        cooldownSeconds: Math.ceil(remaining / 1000),
      };
    }

    await ctx.scheduler.runAfter(0, internal.deals.run.execute, {
      userId: user._id,
      trigger: "prompt",
    });

    return { ok: true };
  },
});

/** The most recent run, so the console can show what happened. */
export const latestRun = query({
  args: { sessionToken: v.optional(v.string()) },
  returns: v.union(
    v.null(),
    v.object({
      status: v.string(),
      startedAt: v.number(),
      finishedAt: v.optional(v.number()),
      couponsMatched: v.number(),
      error: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const user = await userForToken(ctx, args.sessionToken);
    if (user === null) return null;

    const run = await ctx.db
      .query("runs")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .first();
    if (run === null) return null;

    return {
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      couponsMatched: run.counts.couponsMatched,
      error: run.error,
    };
  },
});

/**
 * Finds deals covering a recipe's ingredients.
 *
 * The seam for the recipe-search work. Matches against coupons already stored
 * rather than searching the web per ingredient: a ten-ingredient recipe would
 * otherwise cost ten times a normal run, on the path most likely to be called
 * in a loop.
 */
export const findForIngredients = mutation({
  args: {
    sessionToken: v.string(),
    ingredients: v.array(v.string()),
  },
  returns: v.object({ ok: v.boolean(), error: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const user = await userForToken(ctx, args.sessionToken);
    if (user === null) {
      return { ok: false, error: "Please verify your email again." };
    }
    if (args.ingredients.length === 0) {
      return { ok: false, error: "No ingredients given." };
    }

    await ctx.scheduler.runAfter(0, internal.deals.run.execute, {
      userId: user._id,
      trigger: "ingredients",
      ingredients: args.ingredients,
    });

    return { ok: true };
  },
});
