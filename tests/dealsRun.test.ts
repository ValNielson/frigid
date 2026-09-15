// @vitest-environment edge-runtime

/**
 * The run as a chain of scheduled steps.
 *
 * It used to be one action holding everything, which could not survive the
 * request limiter: a cold city spends its per-minute budget on discovery, and
 * every merchant afterwards was either asleep or refused. A live San Diego run
 * skipped all nine stores it had just planned for.
 */

import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { MAX_MERCHANT_ATTEMPTS } from "../convex/deals/policy";
import { DEAL_STALL_AFTER_MS } from "../convex/recipePolicy";

const modules = import.meta.glob("../convex/**/*.ts");
const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

beforeEach(() => {
  process.env.VERIFICATION_CODE_PEPPER = "test-pepper";
});

/** A recipe job parked in the deals step, waiting on a run. */
async function seedWaitingJob(t: T, userId: Id<"users">, staleByMs: number) {
  const now = Date.now();
  return await t.run(async (ctx) => {
    const jobId = await ctx.db.insert("recipeJobs", {
      userId,
      prompt: "mediterranean food",
      searchQuery: "mediterranean food recipe",
      status: "dealing",
      statusDetail: "Checking what is on sale near you",
      candidates: [],
      recipes: [],
      shopping: [],
      skipped: [],
      creditsUsed: 0,
      llmCallsUsed: 0,
      createdAt: now - staleByMs,
      updatedAt: now - staleByMs,
    });
    return jobId;
  });
}

async function seedRun(t: T) {
  const now = Date.now();
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "cook@example.com",
      verifiedAt: now,
      onboardedAt: now,
      subscribed: true,
      unsubscribeToken: "unsubscribe-token",
      attemptsRemaining: 0,
      sendsInWindow: 0,
      windowStartedAt: now,
    });
    const runId = await ctx.db.insert("runs", {
      userId,
      kind: "deals",
      status: "running",
      trigger: "test",
      startedAt: now,
      counts: {
        merchants: 0,
        scraped: 0,
        couponsFound: 0,
        couponsMatched: 0,
        offMetroDropped: 0,
        merchantsFresh: 0,
      },
    });
    const merchantId = await ctx.db.insert("merchants", {
      name: "Meijer",
      domain: "meijer.com",
      kind: "grocery",
      source: "static",
      discoveredAt: now,
    });
    // Already read for this metro today, so the step should skip it rather than
    // spend a request — which is what keeps this test free of the network.
    await ctx.db.insert("merchantScrapes", {
      merchantId,
      metroKey: "cleveland, oh",
      lastScrapedAt: now,
    });
    return { userId, runId, merchantId };
  });
}

function stateFor(runId: Id<"runs">, userId: Id<"users">, targets: string[]) {
  return {
    runId,
    userId,
    wanted: targets,
    targets,
    skipped: [],
    chainDomains: ["meijer.com"],
    metro: { city: "Cleveland", state: "OH" },
    metroKey: "cleveland, oh",
    place: "Cleveland, OH",
    fallbackQuery: "weekly ad grocery deals",
    sendEmail: false,
    counts: {
      merchants: targets.length,
      scraped: 0,
      couponsFound: 0,
      couponsMatched: 0,
      offMetroDropped: 0,
      merchantsFresh: 0,
    },
  };
}

test("a merchant still fresh for this metro costs no request", async () => {
  const t = harness();
  const { runId, userId } = await seedRun(t);

  await t.action(internal.deals.run.scrapeMerchant, {
    state: stateFor(runId, userId, ["meijer.com"]),
    index: 0,
    attempt: 1,
  });
  await t.finishAllScheduledFunctions(() => {});

  const run = await t.run(async (ctx) => ctx.db.get(runId));
  expect(run?.counts.merchantsFresh).toBe(1);
  expect(run?.counts.scraped).toBe(0);
  // No Firecrawl request was reserved, because none was made.
  expect(await t.run(async (ctx) => ctx.db.query("firecrawlRequests").collect())).toHaveLength(0);
});

test("the chain runs to the end and closes the run out", async () => {
  const t = harness();
  const { runId, userId } = await seedRun(t);

  await t.action(internal.deals.run.scrapeMerchant, {
    state: stateFor(runId, userId, ["meijer.com"]),
    index: 0,
    attempt: 1,
  });
  await t.finishAllScheduledFunctions(() => {});

  const run = await t.run(async (ctx) => ctx.db.get(runId));
  // finalize ran: the run is no longer sitting in "running".
  expect(run?.status).not.toBe("running");
  expect(run?.finishedAt).toBeDefined();
});

test("an index past the end goes straight to finalize", async () => {
  const t = harness();
  const { runId, userId } = await seedRun(t);

  await t.action(internal.deals.run.scrapeMerchant, {
    state: stateFor(runId, userId, ["meijer.com"]),
    index: 5,
    attempt: 1,
  });
  await t.finishAllScheduledFunctions(() => {});

  const run = await t.run(async (ctx) => ctx.db.get(runId));
  expect(run?.status).not.toBe("running");
  expect(run?.counts.scraped).toBe(0);
});

test("an exhausted budget stops the chain and records what was left", async () => {
  const t = harness();
  const { runId, userId } = await seedRun(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("creditLedger", {
      feature: "deals",
      credits: 10_000,
      at: Date.now(),
    });
  });

  await t.action(internal.deals.run.scrapeMerchant, {
    state: stateFor(runId, userId, ["meijer.com", "kroger.com", "aldi.us"]),
    index: 0,
    attempt: 1,
  });
  await t.finishAllScheduledFunctions(() => {});

  const run = await t.run(async (ctx) => ctx.db.get(runId));
  // Everything from here on is reported as skipped rather than silently lost.
  expect(run?.skippedMerchants).toEqual(["meijer.com", "kroger.com", "aldi.us"]);
  expect(run?.counts.scraped).toBe(0);
});

test("the retry budget is more than one attempt", () => {
  // A merchant the limiter turns away is rescheduled rather than abandoned;
  // abandoning on the first refusal is what made a live run skip every store.
  expect(MAX_MERCHANT_ATTEMPTS).toBeGreaterThan(1);
});

/**
 * The chain is deliberately slow, and nothing else touches the job row while it
 * runs. A live San Diego run sat in the deals step for half an hour looking
 * stalled to the screen while it was working perfectly.
 */
test("each merchant step moves the waiting job's clock", async () => {
  const t = harness();
  const { runId, userId } = await seedRun(t);
  const jobId = await seedWaitingJob(t, userId, DEAL_STALL_AFTER_MS + 60_000);

  const before = await t.run(async (ctx) => ctx.db.get(jobId));
  expect(Date.now() - (before?.updatedAt ?? 0)).toBeGreaterThan(DEAL_STALL_AFTER_MS);

  await t.action(internal.deals.run.scrapeMerchant, {
    state: { ...stateFor(runId, userId, ["meijer.com"]), recipeJobId: jobId },
    index: 0,
    attempt: 1,
  });

  const after = await t.run(async (ctx) => ctx.db.get(jobId));
  // No longer reads as stalled...
  expect(Date.now() - (after?.updatedAt ?? 0)).toBeLessThan(DEAL_STALL_AFTER_MS);
  // ...and says something truer than a static "checking".
  expect(after?.statusDetail).toContain("meijer.com");
  expect(after?.statusDetail).toContain("1 of 1");
  // The heartbeat must not move the job out of the deals step.
  expect(after?.status).toBe("dealing");
});

test("a run with no waiting job touches no job row", async () => {
  const t = harness();
  const { runId, userId } = await seedRun(t);
  const jobId = await seedWaitingJob(t, userId, 60_000);

  // recipeJobId absent: a cron or prompt run has no job to report to.
  await t.action(internal.deals.run.scrapeMerchant, {
    state: stateFor(runId, userId, ["meijer.com"]),
    index: 0,
    attempt: 1,
  });

  const job = await t.run(async (ctx) => ctx.db.get(jobId));
  expect(job?.statusDetail).toBe("Checking what is on sale near you");
});

/**
 * The same run still has to report somewhere. Reporting only to a recipe job is
 * why a prompt run looked stalled from the outside for its whole length: there
 * was no job, so every heartbeat was a no-op and the row never moved.
 */
test("a run with no waiting job still reports its own progress", async () => {
  const t = harness();
  const { runId, userId } = await seedRun(t);

  await t.action(internal.deals.run.scrapeMerchant, {
    state: stateFor(runId, userId, ["meijer.com"]),
    index: 0,
    attempt: 1,
  });

  const run = await t.run(async (ctx) => ctx.db.get(runId));
  expect(run?.statusDetail).toContain("meijer.com");
  expect(run?.statusDetail).toContain("1 of 1");
  expect(Date.now() - (run?.updatedAt ?? 0)).toBeLessThan(DEAL_STALL_AFTER_MS);
  // Progress must not move the run out of the step it is in.
  expect(run?.status).toBe("running");
});
