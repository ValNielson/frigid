import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { DAILY_CREDIT_BUDGET } from "./recipePolicy";

/**
 * The shared Firecrawl credit ledger.
 *
 * Firecrawl's free tier is 1,000 credits a month and both pipelines draw on it,
 * so the only honest budget is one both of them write to. Recipe search and
 * coupon discovery each record here; the guard reads the sum.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const record = internalMutation({
  args: { feature: v.string(), credits: v.number(), at: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.credits <= 0) return null;
    await ctx.db.insert("creditLedger", args);
    return null;
  },
});

/** Credits spent in the last 24 hours, across every feature. */
export const spentToday = internalQuery({
  args: { now: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("creditLedger")
      .withIndex("by_at", (q) => q.gt("at", args.now - DAY_MS))
      .collect();
    return rows.reduce((total, row) => total + row.credits, 0);
  },
});

/** Whether there is room in today's budget to start more paid work. */
export const withinBudget = internalQuery({
  args: { now: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const rows = await ctx.db
      .query("creditLedger")
      .withIndex("by_at", (q) => q.gt("at", args.now - DAY_MS))
      .collect();
    const spent = rows.reduce((total, row) => total + row.credits, 0);
    return spent < DAILY_CREDIT_BUDGET;
  },
});
