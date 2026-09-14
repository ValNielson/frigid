// @vitest-environment edge-runtime

/**
 * The food vocabulary, and the fact that it teaches itself.
 *
 * "Is this food?" used to be answered by a denylist of sixty-nine product
 * names, which is the wrong shape: not-food is unbounded, so the list only ever
 * grew after something unwanted had already reached a user — and it still let a
 * dog treat through. Food is the bounded side, and this project already keeps
 * that vocabulary twice over for other reasons.
 */

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { STATIC_FOOD_WORDS, looksLikeFood } from "../convex/foodVocabulary";

const modules = import.meta.glob("../convex/**/*.ts");
const harness = () => convexTest(schema, modules);

test("the static floor is derived, not hand-written", () => {
  // Department keywords and allergen terms, composed. Adding a department
  // keyword widens this for free.
  expect(STATIC_FOOD_WORDS.size).toBeGreaterThan(200);
  for (const word of ["bacon", "celery", "cheese", "tortilla", "cumin"]) {
    expect(STATIC_FOOD_WORDS.has(word)).toBe(true);
  }
});

test("the static floor genuinely does not cover everything", () => {
  // This is why the vocabulary has to learn, and why it is a second opinion
  // rather than the decision: all of these are real food from a live pool.
  for (const word of ["gnocchi", "samosa", "watermelon", "flan"]) {
    expect(looksLikeFood(word)).toBe(false);
  }
});

test("reading a recipe teaches words the static lists never had", async () => {
  const t = harness();

  expect(looksLikeFood("gnocchi")).toBe(false);

  await t.mutation(internal.recipeCache.putRecipe, {
    urlKey: "example.com/gnocchi",
    recipe: {
      url: "https://example.com/gnocchi",
      domain: "example.com",
      name: "Sheet Pan Gnocchi",
      source: "jsonld" as const,
      ingredients: [
        { raw: "1 lb potato gnocchi", item: "gnocchi" },
        { raw: "2 cups halloumi, cubed", item: "halloumi" },
      ],
    },
  });

  const learned = new Set(
    await t.query(internal.recipeCache.knownFoodWords, {}),
  );
  expect(learned.has("gnocchi")).toBe(true);
  expect(learned.has("halloumi")).toBe(true);

  // And now the coupon filter would recognise them.
  expect(looksLikeFood("gnocchi", learned)).toBe(true);
  expect(looksLikeFood("halloumi", learned)).toBe(true);
});

test("the same word is learned once, however many recipes use it", async () => {
  const t = harness();
  const recipe = (urlKey: string) => ({
    urlKey,
    recipe: {
      url: `https://example.com/${urlKey}`,
      domain: "example.com",
      name: "Something",
      source: "jsonld" as const,
      ingredients: [{ raw: "1 lb gnocchi", item: "gnocchi" }],
    },
  });

  await t.mutation(internal.recipeCache.putRecipe, recipe("a"));
  await t.mutation(internal.recipeCache.putRecipe, recipe("b"));

  const rows = await t.run(async (ctx) => ctx.db.query("foodWords").collect());
  expect(rows.filter((row) => row.word === "gnocchi")).toHaveLength(1);
});

test("a learned word lets an unplaced coupon through the filter", async () => {
  const t = harness();
  await t.mutation(internal.recipeCache.putRecipe, {
    urlKey: "example.com/samosa",
    recipe: {
      url: "https://example.com/samosa",
      domain: "example.com",
      name: "Samosas",
      source: "jsonld" as const,
      ingredients: [{ raw: "12 vegetable samosas", item: "samosa" }],
    },
  });

  const learned = new Set(
    await t.query(internal.recipeCache.knownFoodWords, {}),
  );
  // An honest "other" from the extractor, which the static lists would have
  // thrown away.
  expect(looksLikeFood("samosa 6 for $4", learned)).toBe(true);
});
