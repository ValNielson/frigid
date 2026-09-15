import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { userForToken } from "./sessions";
import { DEAL_STALL_AFTER_MS } from "./recipePolicy";

/**
 * The public surface for coupon discovery.
 *
 * Everything here resolves a session first, so a run is always attributable to
 * one person, and the work itself is scheduled rather than awaited — a run
 * outlives a single action's request window, which is why the console tells
 * people their results arrive by email.
 */

/**
 * Convex derives a function's client-facing type from its handler, and a
 * handler whose branches return different key sets infers as a union the client
 * cannot read a field off. Naming the shape once is the same fix verification.ts
 * uses for requestCode and verifyCode.
 */
type RunRequestResult = {
  ok: boolean;
  error?: string;
  cooldownSeconds?: number;
};

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
  handler: async (ctx, args): Promise<RunRequestResult> => {
    const user = await userForToken(ctx, args.sessionToken);
    if (user === null) {
      return { ok: false, error: "Please verify your email again." };
    }

    const blocked = await ctx.runQuery(internal.deals.data.runBlocked, {
      userId: user._id,
      now: Date.now(),
    });
    if (blocked !== null) return { ok: false, ...blocked };

    const runId = await ctx.runMutation(internal.deals.data.startRun, {
      userId: user._id,
      kind: "deals",
      trigger: "prompt",
      now: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.deals.run.execute, {
      userId: user._id,
      runId,
      trigger: "prompt",
    });

    return { ok: true };
  },
});

/**
 * The most recent run, so the screens can show what happened.
 *
 * Not filtered by trigger: a cron digest and a prompt are the same work on the
 * same profile, and hiding the one the user did not personally start would show
 * them "nothing yet" while a run was going. `trigger` is returned so the screen
 * can word it honestly instead.
 */
export const latestRun = query({
  args: { sessionToken: v.optional(v.string()) },
  returns: v.union(
    v.null(),
    v.object({
      status: v.string(),
      statusDetail: v.optional(v.string()),
      /** Derived, not stored: a step that died leaves the row untouched. */
      stalled: v.boolean(),
      kind: v.string(),
      trigger: v.string(),
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
      statusDetail: run.statusDetail,
      // Falls back to the start time for rows written before the heartbeat
      // reached this table, and for the window before the first step reports.
      stalled:
        run.status === "running" &&
        Date.now() - (run.updatedAt ?? run.startedAt) > DEAL_STALL_AFTER_MS,
      kind: run.kind,
      trigger: run.trigger,
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
  handler: async (ctx, args): Promise<RunRequestResult> => {
    const user = await userForToken(ctx, args.sessionToken);
    if (user === null) {
      return { ok: false, error: "Please verify your email again." };
    }
    if (args.ingredients.length === 0) {
      return { ok: false, error: "No ingredients given." };
    }

    const blocked = await ctx.runQuery(internal.deals.data.runBlocked, {
      userId: user._id,
      now: Date.now(),
    });
    if (blocked !== null) return { ok: false, error: blocked.error };

    const runId = await ctx.runMutation(internal.deals.data.startRun, {
      userId: user._id,
      kind: "ingredients",
      trigger: "ingredients",
      now: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.deals.run.execute, {
      userId: user._id,
      runId,
      trigger: "ingredients",
      ingredients: args.ingredients,
    });

    return { ok: true };
  },
});
