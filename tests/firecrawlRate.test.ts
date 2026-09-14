// @vitest-environment edge-runtime

/**
 * The shared request limiter.
 *
 * Firecrawl's ten-a-minute ceiling is one budget both pipelines draw on, and a
 * live run died proving that pacing each loop separately cannot enforce it: the
 * recipe half spent its requests and immediately triggered a coupon run inside
 * the same minute.
 */

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import {
  FIRECRAWL_REQUESTS_PER_MINUTE,
  MAX_LIMITER_WAIT_MS,
} from "../convex/firecrawlRate";

const modules = import.meta.glob("../convex/**/*.ts");
const harness = () => convexTest(schema, modules);
const NOW = 1_800_000_000_000;

const reserve = (t: ReturnType<typeof harness>, weight: number, now = NOW) =>
  t.mutation(internal.firecrawlRate.reserve, { weight, now });

const rows = (t: ReturnType<typeof harness>) =>
  t.run(async (ctx) => ctx.db.query("firecrawlRequests").collect());

test("a request under the cap goes straight through and claims a slot", async () => {
  const t = harness();
  expect(await reserve(t, 1)).toEqual({ waitMs: 0, deferred: false });
  expect(await rows(t)).toHaveLength(1);
});

test("filling the window exactly still grants", async () => {
  const t = harness();
  for (let i = 0; i < FIRECRAWL_REQUESTS_PER_MINUTE; i += 1) {
    expect((await reserve(t, 1, NOW + i)).deferred).toBe(false);
  }
  expect(await rows(t)).toHaveLength(FIRECRAWL_REQUESTS_PER_MINUTE);
});

test("the next request past the cap is made to wait", async () => {
  const t = harness();
  for (let i = 0; i < FIRECRAWL_REQUESTS_PER_MINUTE; i += 1) {
    await reserve(t, 1, NOW);
  }
  const slot = await reserve(t, 1, NOW + 1_000);
  expect(slot.deferred).toBe(false);
  expect(slot.waitMs).toBeGreaterThan(0);
  // Claimed for the moment it will actually fire, so the next caller queues
  // behind it rather than racing it.
  expect(await rows(t)).toHaveLength(FIRECRAWL_REQUESTS_PER_MINUTE + 1);
});

test("requests that have rolled out of the window stop counting", async () => {
  const t = harness();
  for (let i = 0; i < FIRECRAWL_REQUESTS_PER_MINUTE; i += 1) {
    await reserve(t, 1, NOW);
  }
  // A minute and a bit later the window is empty again.
  expect(await reserve(t, 1, NOW + 61_000)).toEqual({
    waitMs: 0,
    deferred: false,
  });
});

test("a queue already more than a window deep defers instead of sleeping", async () => {
  const t = harness();
  // Fill the window, then keep asking. Each grant is claimed for a future
  // moment, so the queue walks forward until asking again would mean sleeping
  // longer than a whole window.
  let deferredAt = -1;
  for (let i = 0; i < 40; i += 1) {
    const slot = await reserve(t, 1, NOW);
    expect(slot.waitMs).toBeLessThanOrEqual(MAX_LIMITER_WAIT_MS);
    if (slot.deferred) {
      deferredAt = i;
      break;
    }
  }
  expect(deferredAt).toBeGreaterThan(0);

  // Deferring must not consume a slot, or a skipped merchant would still
  // penalise whichever one comes next.
  const before = (await rows(t)).length;
  expect((await reserve(t, 1, NOW)).deferred).toBe(true);
  expect(await rows(t)).toHaveLength(before);
});

/** The property per-loop pacing could never give us. */
test("a recipe request and a coupon request share one window", async () => {
  const t = harness();
  // The recipe pipeline's scrapes.
  for (let i = 0; i < FIRECRAWL_REQUESTS_PER_MINUTE - 1; i += 1) {
    await reserve(t, 1, NOW);
  }
  // The coupon run that attachDeals fires immediately afterwards, weighted the
  // way searchDeals is.
  const slot = await reserve(t, 3, NOW + 500);
  expect(slot.waitMs).toBeGreaterThan(0);
});

test("pruning drops only what has left the window", async () => {
  const t = harness();
  await t.run(async (ctx) => {
    await ctx.db.insert("firecrawlRequests", { at: Date.now() - 120_000, weight: 1 });
    await ctx.db.insert("firecrawlRequests", { at: Date.now(), weight: 1 });
  });
  expect(await t.mutation(internal.firecrawlRate.prune, {})).toBe(1);
  expect(await rows(t)).toHaveLength(1);
});
