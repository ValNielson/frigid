// @vitest-environment edge-runtime

/**
 * The seam between recipe search and coupons.
 *
 * The two pipelines shipped disconnected: findForIngredients had no callers and
 * recipeRun never mentioned coupons. These pin the behaviour that connects them,
 * including the rule that deals are a bonus and must never cost a user the
 * recipes they actually asked for.
 */

import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { MAX_DEALS_PER_JOB } from "../convex/recipePolicy";

const modules = import.meta.glob("../convex/**/*.ts");

beforeEach(() => {
  process.env.VERIFICATION_CODE_PEPPER = "test-pepper";
});

const harness = () => convexTest(schema, modules);
type T = ReturnType<typeof harness>;

/** What the extractor would have said each offer is for. */
function primaryItemFor(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes("chicken")) return "chicken";
  if (lower.includes("celery")) return "celery";
  if (lower.includes("cream cheese")) return "cheese";
  if (lower.includes("soap")) return "soap";
  if (lower.includes("motor oil")) return "oil";
  return "snack";
}

const SHOPPING = [
  { item: "chicken", usedIn: ["Buffalo Chicken Dip"], department: "Meat & Seafood", stores: [] },
  { item: "cream cheese", usedIn: ["Buffalo Chicken Dip"], department: "Dairy & Eggs", stores: [] },
  { item: "celery", usedIn: ["Buffalo Chicken Dip"], department: "Produce", stores: [] },
];

const METRO = "cleveland, oh";

async function seed(
  t: T,
  opts: { location?: string; allergies?: string[]; coupons?: string[] } = {},
) {
  const now = Date.now();
  const location = opts.location ?? "Cleveland, Ohio";
  return await t.run(async (ctx) => {
    // attachDeals reads this cache rather than paying a model to resolve the
    // city, so without it every pool reads as empty.
    if (location.length > 0) {
      await ctx.db.insert("locations", {
        raw: location.toLowerCase(),
        city: "Cleveland",
        state: "OH",
        normalizedAt: now,
      });
    }
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
    await ctx.db.insert("preferences", {
      userId,
      schemaVersion: 1,
      answers: {
        stores: { choices: ["Meijer"] },
        allergies: { choices: opts.allergies ?? [] },
        location: { choices: [], other: location },
      },
      summaryText: "",
      promptContext: "",
      completedAt: now,
      updatedAt: now,
    });

    const merchantId = await ctx.db.insert("merchants", {
      name: "Meijer",
      domain: "meijer.com",
      kind: "grocery",
      source: "static",
      discoveredAt: now,
    });
    for (const title of opts.coupons ?? []) {
      await ctx.db.insert("coupons", {
        userId: null,
        merchantId,
        title,
        itemTerms: [],
        tags: [],
        primaryItem: primaryItemFor(title),
        metroKey: METRO,
        sourceKind: "scrape",
        dedupeKey: `${METRO}|meijer.com|${title}|`,
        foundAt: now,
      });
    }

    const jobId = await ctx.db.insert("recipeJobs", {
      userId,
      prompt: "buffalo chicken dip",
      searchQuery: "buffalo chicken dip recipe",
      status: "shopping",
      candidates: [],
      recipes: [
        {
          url: "https://food.com/buffalo-chicken-dip",
          name: "Buffalo Chicken Dip",
          source: "jsonld" as const,
          ingredients: [{ raw: "2 cups shredded chicken", item: "chicken" }],
        },
      ],
      shopping: SHOPPING,
      skipped: [],
      creditsUsed: 0,
      llmCallsUsed: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { userId, jobId, merchantId };
  });
}

const jobRow = (t: T, jobId: Id<"recipeJobs">) =>
  t.run(async (ctx) => ctx.db.get(jobId));

test("a warm pool attaches matching deals without waiting on a scrape", async () => {
  const t = harness();
  const { jobId } = await seed(t, {
    coupons: ["Boneless chicken breast 2 for $9", "Fresh celery bunch 99c", "Laundry soap $4"],
  });

  await t.action(internal.recipeRun.attachDeals, { jobId });

  const job = await jobRow(t, jobId);
  const titles = (job?.deals ?? []).map((deal) => deal.title);
  expect(titles.some((title) => title.includes("chicken"))).toBe(true);
  expect(titles.some((title) => title.includes("celery"))).toBe(true);
  // Matched from coupons already held, so the job never entered the deals step.
  expect(job?.status).not.toBe("dealing");
});

/**
 * The pool being warm says the answer was cheap, not that it was good. A live
 * Cleveland search matched none of nineteen ingredients against sixty-five held
 * coupons — correct, and a disappointing inbox — so the search now runs behind
 * the recipe email rather than being skipped.
 */
test("a warm pool still starts a search once the recipes are away", async () => {
  const t = harness();
  const { jobId } = await seed(t, { coupons: ["Boneless chicken breast 2 for $9"] });

  await t.action(internal.recipeRun.attachDeals, { jobId });

  const runs = await t.run(async (ctx) => ctx.db.query("runs").collect());
  expect(runs).toHaveLength(1);
  expect(runs[0]?.trigger).toBe("recipe-after");
  // Profile-wide, not narrowed to the list that just came back empty.
  expect(runs[0]?.kind).toBe("deals");
});

test("the follow-up search is refused when the guard says no", async () => {
  const t = harness();
  const { userId, jobId } = await seed(t, {
    coupons: ["Boneless chicken breast 2 for $9"],
  });

  // A run already inside the cooldown is exactly what the guard exists to stop.
  await t.mutation(internal.deals.data.startRun, {
    userId,
    kind: "deals",
    trigger: "cron",
    now: Date.now(),
  });

  await t.action(internal.recipeRun.attachDeals, { jobId });

  const runs = await t.run(async (ctx) => ctx.db.query("runs").collect());
  expect(runs).toHaveLength(1);
  expect(runs[0]?.trigger).toBe("cron");
});

test("a deal is labelled with the store it came from", async () => {
  const t = harness();
  const { jobId } = await seed(t, { coupons: ["Boneless chicken breast 2 for $9"] });
  await t.action(internal.recipeRun.attachDeals, { jobId });
  const job = await jobRow(t, jobId);
  expect(job?.deals?.[0]?.merchantName).toBe("Meijer");
});

test("an unrelated coupon is not attached", async () => {
  const t = harness();
  const { jobId } = await seed(t, { coupons: ["Laundry soap $4", "Motor oil 20% off"] });
  await t.action(internal.recipeRun.attachDeals, { jobId });
  expect((await jobRow(t, jobId))?.deals).toEqual([]);
});

test("an allergen-tripping coupon never reaches the job", async () => {
  const t = harness();
  const { jobId } = await seed(t, {
    allergies: ["Milk or dairy"],
    coupons: ["Cream cheese 2 for $5", "Boneless chicken breast 2 for $9"],
  });

  await t.action(internal.recipeRun.attachDeals, { jobId });

  const titles = ((await jobRow(t, jobId))?.deals ?? []).map((deal) => deal.title);
  expect(titles.some((title) => title.toLowerCase().includes("cream cheese"))).toBe(
    false,
  );
  expect(titles.some((title) => title.includes("chicken"))).toBe(true);
});

test("deals are capped", async () => {
  const t = harness();
  const { jobId } = await seed(t, {
    coupons: Array.from({ length: MAX_DEALS_PER_JOB + 4 }, (_, i) => `Chicken offer ${i}`),
  });
  await t.action(internal.recipeRun.attachDeals, { jobId });
  expect((await jobRow(t, jobId))?.deals?.length).toBe(MAX_DEALS_PER_JOB);
});

/**
 * The cold path. Nobody has scraped this city, so the step hands off to a real
 * coupon run rather than reporting "no deals" — and leaves the job in "dealing"
 * so the run can release the email when it lands.
 */
test("an empty pool with a location starts exactly one run and waits", async () => {
  const t = harness();
  const { jobId } = await seed(t, { coupons: [] });

  await t.action(internal.recipeRun.attachDeals, { jobId });

  const runs = await t.run(async (ctx) => ctx.db.query("runs").collect());
  expect(runs).toHaveLength(1);
  expect(runs[0]?.trigger).toBe("recipe-cold");
  expect((await jobRow(t, jobId))?.status).toBe("dealing");
});

test("an empty pool with no location does not start a run", async () => {
  const t = harness();
  const { jobId } = await seed(t, { coupons: [], location: "" });

  await t.action(internal.recipeRun.attachDeals, { jobId });

  expect(await t.run(async (ctx) => ctx.db.query("runs").collect())).toHaveLength(0);
  expect((await jobRow(t, jobId))?.deals).toEqual([]);
});

/**
 * The guard the two public entry points read. A recipe search must not be able
 * to walk around the budget that protects every other run.
 */
test("an exhausted budget skips the cold run instead of spending", async () => {
  const t = harness();
  const { jobId } = await seed(t, { coupons: [] });
  await t.run(async (ctx) => {
    await ctx.db.insert("creditLedger", {
      feature: "recipes",
      credits: 10_000,
      at: Date.now(),
    });
  });

  await t.action(internal.recipeRun.attachDeals, { jobId });

  expect(await t.run(async (ctx) => ctx.db.query("runs").collect())).toHaveLength(0);
  expect((await jobRow(t, jobId))?.deals).toEqual([]);
});

/** Deals are a bonus; the recipes are what the user asked for. */
test("a job with no shopping list still finishes rather than failing", async () => {
  const t = harness();
  const { jobId } = await seed(t, { coupons: ["Chicken 2 for $9"] });
  await t.run(async (ctx) => {
    await ctx.db.patch(jobId, { shopping: [] });
  });

  await t.action(internal.recipeRun.attachDeals, { jobId });

  const job = await jobRow(t, jobId);
  expect(job?.status).not.toBe("failed");
  expect(job?.deals).toEqual([]);
});

/**
 * The defect the first live Cleveland run exposed: a chain's Grand Rapids ad was
 * shown to a Cleveland shopper, and — worse — made their pool look warm so their
 * own city was never scraped.
 */
test("another city's coupon is invisible, and the cold run fires because of it", async () => {
  const t = harness();
  const { jobId, merchantId } = await seed(t, { coupons: [] });

  await t.run(async (ctx) => {
    await ctx.db.insert("coupons", {
      userId: null,
      merchantId,
      title: "Boneless chicken breast 2 for $9",
      primaryItem: "chicken",
      metroKey: "grand rapids, mi",
      itemTerms: ["chicken"],
      tags: [],
      sourceKind: "scrape",
      dedupeKey: "grand rapids, mi|meijer.com|chicken|",
      foundAt: Date.now(),
    });
  });

  await t.action(internal.recipeRun.attachDeals, { jobId });

  // Not attached. On the cold path deals stays unset until the run writes back,
  // so the assertion is "nothing from Michigan", not "an empty array".
  const job = await jobRow(t, jobId);
  expect(job?.deals ?? []).toEqual([]);
  expect(job?.status).toBe("dealing");
  // ...and the leak no longer passes for coverage of Cleveland either.
  const runs = await t.run(async (ctx) => ctx.db.query("runs").collect());
  expect(runs).toHaveLength(1);
  expect(runs[0]?.trigger).toBe("recipe-cold");
});

test("a coupon mined from the user's own mail ignores the metro", async () => {
  const t = harness();
  const { jobId, userId, merchantId } = await seed(t, { coupons: [] });

  await t.run(async (ctx) => {
    await ctx.db.insert("coupons", {
      userId,
      merchantId,
      title: "Your chicken coupon",
      primaryItem: "chicken",
      itemTerms: ["chicken"],
      tags: [],
      sourceKind: "email",
      dedupeKey: "mail|chicken|",
      foundAt: Date.now(),
    });
  });

  await t.action(internal.recipeRun.attachDeals, { jobId });

  // It arrived because this person signed up for that list, so it is theirs
  // wherever they live.
  expect((await jobRow(t, jobId))?.deals?.[0]?.title).toBe("Your chicken coupon");
});
