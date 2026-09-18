// @vitest-environment edge-runtime

/**
 * The guard in front of coupon discovery, and the cadence the cron reads.
 *
 * A run is the most expensive thing this product does — up to five merchants at
 * twelve Firecrawl credits each — so what refuses one is worth pinning down.
 */

import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import schema from "../convex/schema";
import { api, internal } from "../convex/_generated/api";
import { hashSessionToken } from "../convex/hash";
import { MANUAL_RUN_COOLDOWN_MS } from "../convex/deals/policy";
import { DAILY_CREDIT_BUDGET, DEAL_STALL_AFTER_MS } from "../convex/recipePolicy";

const modules = import.meta.glob("../convex/**/*.ts");
const PEPPER = "test-pepper";
const TOKEN = "a-session-token";

beforeEach(() => {
  process.env.VERIFICATION_CODE_PEPPER = PEPPER;
});

function harness() {
  return convexTest(schema, modules);
}

/** A verified, onboarded user holding a live session. */
async function signIn(t: ReturnType<typeof harness>) {
  const tokenHash = await hashSessionToken(TOKEN, PEPPER);
  const now = Date.now();
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "someone@example.com",
      verifiedAt: now,
      onboardedAt: now,
      subscribed: true,
      unsubscribeToken: "unsubscribe-token",
      attemptsRemaining: 0,
      sendsInWindow: 0,
      windowStartedAt: now,
    });
    await ctx.db.insert("sessions", {
      userId,
      tokenHash,
      expiresAt: now + 60_000,
      createdAt: now,
      lastSeenAt: now,
    });
    return userId;
  });
}

/**
 * The guard itself, rather than a mutation wrapping it.
 *
 * It used to be reached through two public mutations; both are gone with the
 * Ask screen, and the recipe pipeline's deals step is the only caller left. The
 * rules it enforces are unchanged, so they are pinned here directly — the guard
 * is what costs money when it is wrong, not whoever calls it.
 */
test("a fresh user is allowed to run", async () => {
  const t = harness();
  const userId = await signIn(t);

  expect(
    await t.query(internal.deals.data.runBlocked, { userId, now: Date.now() }),
  ).toBeNull();
});

/**
 * The row has to exist by the time the run is started, not once the scheduled
 * action gets around to it. It used to be written by the action, so two
 * requests in a row both saw an empty table, both passed the cooldown, and both
 * paid.
 */
test("starting a run writes its row at once, and that row blocks the next", async () => {
  const t = harness();
  const userId = await signIn(t);
  const now = Date.now();

  await t.mutation(internal.deals.data.startRun, {
    userId,
    kind: "deals",
    trigger: "recipe-cold",
    now,
  });

  expect(await t.run(async (ctx) => ctx.db.query("runs").collect())).toHaveLength(1);

  const blocked = await t.query(internal.deals.data.runBlocked, { userId, now });
  expect(blocked?.error).toMatch(/still working/i);
  expect(blocked?.cooldownSeconds).toBeGreaterThan(0);
  expect(blocked?.cooldownSeconds).toBeLessThanOrEqual(MANUAL_RUN_COOLDOWN_MS / 1000);
});

test("the cooldown lets go once it has passed", async () => {
  const t = harness();
  const userId = await signIn(t);
  const now = Date.now();

  await t.mutation(internal.deals.data.startRun, {
    userId,
    kind: "deals",
    trigger: "recipe-cold",
    now,
  });

  expect(
    await t.query(internal.deals.data.runBlocked, {
      userId,
      now: now + MANUAL_RUN_COOLDOWN_MS + 1,
    }),
  ).toBeNull();
});

/**
 * The ledger is shared with recipe search. Coupon discovery used to record
 * against it and never read it, so the brake could not stop the heavier of the
 * two pipelines.
 */
test("the shared daily budget stops a run", async () => {
  const t = harness();
  const userId = await signIn(t);

  await t.run(async (ctx) => {
    await ctx.db.insert("creditLedger", {
      feature: "recipes",
      credits: DAILY_CREDIT_BUDGET,
      at: Date.now(),
    });
  });

  const blocked = await t.query(internal.deals.data.runBlocked, {
    userId,
    now: Date.now(),
  });
  expect(blocked?.error).toMatch(/budget/i);
  expect(blocked?.cooldownSeconds).toBeUndefined();
});

test("yesterday's spending does not count against today", async () => {
  const t = harness();
  const userId = await signIn(t);

  await t.run(async (ctx) => {
    await ctx.db.insert("creditLedger", {
      feature: "deals",
      credits: DAILY_CREDIT_BUDGET * 10,
      at: Date.now() - 25 * 60 * 60 * 1000,
    });
  });

  expect(
    await t.query(internal.deals.data.runBlocked, { userId, now: Date.now() }),
  ).toBeNull();
});

/** The one public function left, and it must still refuse a stranger. */
test("the latest run is not readable without a session", async () => {
  const t = harness();
  await signIn(t);

  expect(
    await t.query(api.deals.latestRun, { sessionToken: "not-a-real-token" }),
  ).toBeNull();
});

/**
 * A run that matched nothing sends no mail. Keying the cadence on sends alone
 * left those users due again the next day, and every day after, whatever
 * cadence they picked.
 */
test("starting a cron run spends the cadence even when no mail goes out", async () => {
  const t = harness();
  const userId = await t.run(async (ctx) => {
    const now = Date.now();
    const id = await ctx.db.insert("users", {
      email: "monthly@example.com",
      verifiedAt: now,
      onboardedAt: now,
      emailFrequency: "Once a month",
      subscribed: true,
      unsubscribeToken: "unsubscribe-token",
      attemptsRemaining: 0,
      sendsInWindow: 0,
      windowStartedAt: now,
    });
    await ctx.db.insert("preferences", {
      userId: id,
      schemaVersion: 1,
      answers: { location: { choices: [], other: "Grand Rapids, MI" } },
      summaryText: "",
      promptContext: "",
      completedAt: now,
      updatedAt: now,
    });
    return id;
  });

  const now = Date.now();
  expect(
    await t.query(internal.deals.data.usersDueForDigest, { now }),
  ).toEqual([userId]);

  await t.mutation(internal.deals.data.startRun, {
    userId,
    kind: "deals",
    trigger: "cron",
    now,
  });

  // No digest was sent, so lastDigestAt is still unset — and the user must
  // still not be due tomorrow.
  const after = await t.run(async (ctx) => ctx.db.get(userId));
  expect(after?.lastDigestAt).toBeUndefined();
  expect(after?.lastDigestAttemptAt).toBe(now);

  expect(
    await t.query(internal.deals.data.usersDueForDigest, {
      now: now + 24 * 60 * 60 * 1000,
    }),
  ).toEqual([]);
});

test("the explicit opt-out is never selected by the cron", async () => {
  const t = harness();
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("users", {
      email: "ondemand@example.com",
      verifiedAt: now,
      onboardedAt: now,
      emailFrequency: "Only when I ask",
      subscribed: true,
      unsubscribeToken: "unsubscribe-token",
      attemptsRemaining: 0,
      sendsInWindow: 0,
      windowStartedAt: now,
    });
  });
  expect(
    await t.query(internal.deals.data.usersDueForDigest, { now: Date.now() }),
  ).toEqual([]);
});

/**
 * Convex orders ascending by default, so this query took the oldest rows. Past
 * the cap, every coupon scraped after that point was paid for and never read.
 */
test("the coupon pool takes the newest rows, not the oldest", async () => {
  const t = harness();
  const userId = await signIn(t);

  const merchantId = await t.run(async (ctx) =>
    ctx.db.insert("merchants", {
      name: "meijer.com",
      domain: "meijer.com",
      kind: "grocery",
      source: "static",
      discoveredAt: Date.now(),
    }),
  );

  await t.run(async (ctx) => {
    for (let i = 0; i < 12; i += 1) {
      await ctx.db.insert("coupons", {
        userId: null,
        merchantId,
        title: `offer ${i}`,
        itemTerms: [],
        tags: [],
        sourceKind: "scrape",
        metroKey: "cleveland, oh",
        dedupeKey: `cleveland, oh|meijer.com|offer ${i}|`,
        foundAt: Date.now() + i,
      });
    }
  });

  const pool = await t.query(internal.deals.data.couponsForUser, {
    userId,
    merchantIds: [merchantId],
    metroKey: "cleveland, oh",
    now: Date.now(),
  });

  // The most recently written offer has to be in the pool.
  expect(pool.map((row) => row.title)).toContain("offer 11");
});

test("an expired coupon is not offered", async () => {
  const t = harness();
  const userId = await signIn(t);
  const now = Date.now();

  const merchantId = await t.run(async (ctx) =>
    ctx.db.insert("merchants", {
      name: "meijer.com",
      domain: "meijer.com",
      kind: "grocery",
      source: "static",
      discoveredAt: now,
    }),
  );
  await t.run(async (ctx) => {
    await ctx.db.insert("coupons", {
      userId: null,
      merchantId,
      title: "yesterday's offer",
      itemTerms: [],
      tags: [],
      expiresAt: now - 1,
      sourceKind: "scrape",
      metroKey: "cleveland, oh",
      dedupeKey: "cleveland, oh|meijer.com|yesterday|",
      foundAt: now - 10_000,
    });
  });

  const pool = await t.query(internal.deals.data.couponsForUser, {
    userId,
    merchantIds: [merchantId],
    metroKey: "cleveland, oh",
    now,
  });
  expect(pool).toEqual([]);
});

/**
 * A crashed chain leaves the row in "running" with nothing to say so — there is
 * no watchdog cron. Derived at read time from the heartbeat's clock, the same
 * way a recipe job surfaces the identical failure.
 */
test("a run whose clock has stopped reads as stalled", async () => {
  const t = harness();
  const userId = await signIn(t);
  const now = Date.now();

  const runId = await t.run(async (ctx) =>
    ctx.db.insert("runs", {
      userId,
      kind: "deals",
      status: "running",
      statusDetail: "Checking meijer.com (2 of 5)",
      trigger: "prompt",
      startedAt: now - DEAL_STALL_AFTER_MS - 60_000,
      updatedAt: now - DEAL_STALL_AFTER_MS - 60_000,
      counts: {
        merchants: 0,
        scraped: 0,
        couponsFound: 0,
        couponsMatched: 0,
        offMetroDropped: 0,
        merchantsFresh: 0,
      },
    }),
  );

  expect(await t.query(api.deals.latestRun, { sessionToken: TOKEN })).toMatchObject({
    status: "running",
    stalled: true,
    statusDetail: "Checking meijer.com (2 of 5)",
    trigger: "prompt",
  });

  // A step reporting in clears it: the run was slow, not dead.
  await t.run(async (ctx) => ctx.db.patch(runId, { updatedAt: Date.now() }));
  expect(await t.query(api.deals.latestRun, { sessionToken: TOKEN })).toMatchObject({
    stalled: false,
  });
});

/**
 * Rows written before the heartbeat reached this table carry no clock at all.
 * Measuring those against zero would report every one of them as stalled.
 */
test("a run with no clock is measured from when it started", async () => {
  const t = harness();
  const userId = await signIn(t);

  await t.run(async (ctx) =>
    ctx.db.insert("runs", {
      userId,
      kind: "deals",
      status: "running",
      trigger: "cron",
      startedAt: Date.now(),
      counts: {
        merchants: 0,
        scraped: 0,
        couponsFound: 0,
        couponsMatched: 0,
        offMetroDropped: 0,
        merchantsFresh: 0,
      },
    }),
  );

  expect(await t.query(api.deals.latestRun, { sessionToken: TOKEN })).toMatchObject({
    stalled: false,
  });
});

/**
 * The extractor started naming what an offer is actually for, and the selector's
 * validator did not follow. Convex refuses unknown fields at the argument
 * boundary, so every run died at the final step — after all the scraping was
 * paid for. The field has to survive the call, not be stripped before it:
 * matchIngredients and keepAsFood both read it.
 */
test("the selector accepts a coupon that names its primary item", async () => {
  const t = harness();
  const userId = await signIn(t);
  const now = Date.now();

  const merchantId = await t.run(async (ctx) =>
    ctx.db.insert("merchants", {
      name: "meijer.com",
      domain: "meijer.com",
      kind: "grocery",
      source: "static",
      discoveredAt: now,
    }),
  );
  await t.run(async (ctx) => {
    await ctx.db.insert("coupons", {
      userId: null,
      merchantId,
      title: "peanut butter, 2 for $5",
      primaryItem: "peanut butter",
      itemTerms: ["peanut butter"],
      tags: [],
      sourceKind: "scrape",
      metroKey: "cleveland, oh",
      dedupeKey: "cleveland, oh|meijer.com|peanut butter|",
      foundAt: now,
    });
  });

  // Straight from the reader into the selector, which is the pair that broke.
  const pool = await t.query(internal.deals.data.couponsForUser, {
    userId,
    merchantIds: [merchantId],
    metroKey: "cleveland, oh",
    now,
  });
  expect(pool[0]?.primaryItem).toBe("peanut butter");

  const result = await t.action(internal.deals.match.selectForProfile, {
    coupons: pool,
    // Excluded before any model call, which is what keeps this test offline.
    allergies: ["Peanuts"],
    promptContext: "cooks for two",
  });

  expect(result).toEqual({ picks: [], excludedForAllergies: 1 });
});
