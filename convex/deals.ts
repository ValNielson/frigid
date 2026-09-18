import { v } from "convex/values";
import { query } from "./_generated/server";
import { userForToken } from "./sessions";
import { DEAL_STALL_AFTER_MS } from "./recipePolicy";

/**
 * The public surface for coupon discovery, which is read-only.
 *
 * Nothing here starts a run. The two mutations that did were the Ask screen's
 * backend and an unused ingredients seam; both outlived their callers once the
 * kitchen panel became the only composer. Runs now begin in exactly two places,
 * neither of them reachable from a client: the recipe pipeline's deals step
 * (recipeRun.attachDeals) and the daily cron. A run is the most expensive thing
 * this product does, so having no public way to ask for one is the point.
 */

/**
 * The most recent run, so the screens can show what happened.
 *
 * Not filtered by trigger: a cron digest and a recipe's own deals step are the
 * same work on the same profile, and hiding the one the user did not personally
 * start would show them "nothing yet" while a run was going. `trigger` is
 * returned so the screen can word it honestly instead.
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
