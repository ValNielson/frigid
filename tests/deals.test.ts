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
import { DAILY_CREDIT_BUDGET } from "../convex/recipePolicy";

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

test("a run is refused without a session", async () => {
  const t = harness();
  const result = await t.mutation(api.deals.requestRun, {
    sessionToken: "not-a-real-token",
  });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/verify your email/i);
});

test("the first run is accepted and leaves a row behind", async () => {
  const t = harness();
  await signIn(t);

  expect(await t.mutation(api.deals.requestRun, { sessionToken: TOKEN })).toEqual({
    ok: true,
  });

  const runs = await t.run(async (ctx) => ctx.db.query("runs").collect());
  expect(runs).toHaveLength(1);
  expect(runs[0]?.trigger).toBe("prompt");
});

/**
 * The row has to exist by the time the mutation returns. It used to be written
 * by the scheduled action, so two clicks in a row both saw an empty table, both
 * passed the cooldown, and both paid.
 */
test("a second run straight away is refused, not scheduled", async () => {
  const t = harness();
  await signIn(t);

  await t.mutation(api.deals.requestRun, { sessionToken: TOKEN });
  const second = await t.mutation(api.deals.requestRun, { sessionToken: TOKEN });

  expect(second.ok).toBe(false);
  expect(second.cooldownSeconds).toBeGreaterThan(0);
  expect(second.cooldownSeconds).toBeLessThanOrEqual(MANUAL_RUN_COOLDOWN_MS / 1000);

  const runs = await t.run(async (ctx) => ctx.db.query("runs").collect());
  expect(runs).toHaveLength(1);
});

/**
 * findForIngredients used to enforce nothing at all, which left a public
 * mutation able to schedule unbounded runs in a loop.
 */
test("the ingredients entry point honours the same cooldown", async () => {
  const t = harness();
  await signIn(t);

  await t.mutation(api.deals.requestRun, { sessionToken: TOKEN });
  const second = await t.mutation(api.deals.findForIngredients, {
    sessionToken: TOKEN,
    ingredients: ["chicken", "rice"],
  });

  expect(second.ok).toBe(false);
  expect(await t.run(async (ctx) => ctx.db.query("runs").collect())).toHaveLength(1);
});

test("an empty ingredient list is refused before anything is scheduled", async () => {
  const t = harness();
  await signIn(t);
  const result = await t.mutation(api.deals.findForIngredients, {
    sessionToken: TOKEN,
    ingredients: [],
  });
  expect(result.ok).toBe(false);
  expect(await t.run(async (ctx) => ctx.db.query("runs").collect())).toHaveLength(0);
});

/**
 * The ledger is shared with recipe search. Coupon discovery used to record
 * against it and never read it, so the brake could not stop the heavier of the
 * two pipelines.
 */
test("both entry points stop when the shared daily budget is gone", async () => {
  const t = harness();
  await signIn(t);

  await t.run(async (ctx) => {
    await ctx.db.insert("creditLedger", {
      feature: "recipes",
      credits: DAILY_CREDIT_BUDGET,
      at: Date.now(),
    });
  });

  const run = await t.mutation(api.deals.requestRun, { sessionToken: TOKEN });
  expect(run.ok).toBe(false);
  expect(run.error).toMatch(/budget/i);

  const ingredients = await t.mutation(api.deals.findForIngredients, {
    sessionToken: TOKEN,
    ingredients: ["chicken"],
  });
  expect(ingredients.ok).toBe(false);
  expect(ingredients.error).toMatch(/budget/i);

  expect(await t.run(async (ctx) => ctx.db.query("runs").collect())).toHaveLength(0);
});

test("yesterday's spending does not count against today", async () => {
  const t = harness();
  await signIn(t);

  await t.run(async (ctx) => {
    await ctx.db.insert("creditLedger", {
      feature: "deals",
      credits: DAILY_CREDIT_BUDGET * 10,
      at: Date.now() - 25 * 60 * 60 * 1000,
    });
  });

  expect(await t.mutation(api.deals.requestRun, { sessionToken: TOKEN })).toEqual({
    ok: true,
  });
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
