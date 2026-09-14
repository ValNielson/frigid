import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";

/**
 * The shared Firecrawl request limiter.
 *
 * Firecrawl's free tier allows ten requests a minute. That is a different
 * budget from credits and needs its own accounting: a run can be well inside
 * the credit allowance and still be rejected for asking too fast, which is
 * exactly how a live Cleveland run died having already paid for four merchants.
 *
 * Reserving and counting happen in one mutation on purpose. Reading the count,
 * sleeping, and then recording would let two actions both see room and both
 * fire. Convex's optimistic concurrency makes two reservations that read the
 * same window conflict, and the loser retries against the updated count.
 */

const WINDOW_MS = 60_000;

/**
 * Eight, not the documented ten. The per-call weights below are estimates — a
 * search with server-side extraction is some number of requests we cannot see —
 * so the margin is what absorbs being wrong about them.
 */
export const FIRECRAWL_REQUESTS_PER_MINUTE = 8;

/**
 * Longer than this and the caller is told to skip rather than sleep.
 *
 * One full window, and not less. In a rolling window the first request past the
 * cap has to wait for the oldest one to age out, which is very nearly the whole
 * window — so a smaller number would make deferral the normal path rather than
 * the safety valve it is meant to be.
 *
 * Because no row inside the window can push the wait past this on its own, a
 * deferral means something sharper: reservations have already stacked into the
 * future, so the queue is more than a minute deep. At that point an action is
 * better off skipping the merchant, which the run row already reports under
 * skippedMerchants, than spending its budget asleep.
 */
export const MAX_LIMITER_WAIT_MS = WINDOW_MS;

/** Requests inside the rolling window, including ones reserved for the future. */
async function weightInWindow(ctx: MutationCtx, now: number): Promise<number> {
  const rows = await ctx.db
    .query("firecrawlRequests")
    .withIndex("by_at", (q) => q.gt("at", now - WINDOW_MS))
    .collect();
  return rows.reduce((total, row) => total + row.weight, 0);
}

/**
 * Claims a slot, or says to skip.
 *
 * `waitMs` is how long the caller must sleep before actually making the
 * request. The slot is inserted at that future moment rather than at `now`, so
 * the next caller counts it and queues behind it instead of racing it.
 */
export const reserve = internalMutation({
  args: { weight: v.number(), now: v.number() },
  returns: v.object({ waitMs: v.number(), deferred: v.boolean() }),
  handler: async (ctx, args) => {
    const used = await weightInWindow(ctx, args.now);

    if (used + args.weight <= FIRECRAWL_REQUESTS_PER_MINUTE) {
      await ctx.db.insert("firecrawlRequests", {
        at: args.now,
        weight: args.weight,
      });
      return { waitMs: 0, deferred: false };
    }

    // Not enough room. Wait for as many of the oldest requests to roll out of
    // the window as it takes to fit this one.
    const rows = await ctx.db
      .query("firecrawlRequests")
      .withIndex("by_at", (q) => q.gt("at", args.now - WINDOW_MS))
      .collect();
    const oldestFirst = [...rows].sort((a, b) => a.at - b.at);

    const needed = used + args.weight - FIRECRAWL_REQUESTS_PER_MINUTE;
    let freed = 0;
    let waitMs = 0;
    for (const row of oldestFirst) {
      freed += row.weight;
      waitMs = Math.max(0, row.at + WINDOW_MS - args.now);
      if (freed >= needed) break;
    }

    if (waitMs > MAX_LIMITER_WAIT_MS) return { waitMs: 0, deferred: true };

    await ctx.db.insert("firecrawlRequests", {
      at: args.now + waitMs,
      weight: args.weight,
    });
    return { waitMs, deferred: false };
  },
});

/**
 * Drops rows that have fallen out of the window.
 *
 * Unlike creditLedger this table is pure working state — nothing reads a
 * request older than a minute — so it is swept rather than kept.
 */
export const prune = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const stale = await ctx.db
      .query("firecrawlRequests")
      .withIndex("by_at", (q) => q.lt("at", Date.now() - WINDOW_MS))
      .take(500);
    for (const row of stale) await ctx.db.delete(row._id);
    return stale.length;
  },
});
