/**
 * One allergen table, and the guarantee that it stays one.
 *
 * There used to be two — recipes and coupons each had their own — and they had
 * drifted apart in eleven of twelve categories while both files described
 * allergens as a hard rule. These tests pin the merge so a future edit to one
 * pipeline cannot quietly re-open the gap.
 */

import { test } from "vitest";
import assert from "node:assert/strict";

import { ALLERGEN_TERMS } from "../convex/allergens.ts";
import { ALLERGEN_TERMS as DEALS_TERMS, violatesAllergies } from "../convex/deals/policy.ts";
import { ALLERGEN_KEYWORDS as RECIPE_TERMS } from "../convex/recipeCatalog.ts";
import { containsAllergen, parseIngredientLine } from "../convex/recipeText.ts";
import { QUESTIONS, NO_ALLERGIES } from "../convex/onboardingQuestions.ts";

test("both pipelines read the same table", () => {
  assert.equal(DEALS_TERMS, ALLERGEN_TERMS);
  assert.equal(RECIPE_TERMS, ALLERGEN_TERMS);
});

test("every allergy the questionnaire offers has terms behind it", () => {
  const offered = (QUESTIONS.find((q) => q.id === "allergies")?.options ?? []).filter(
    (option) => option !== NO_ALLERGIES,
  );
  assert.ok(offered.length > 0, "the allergies question should offer options");
  for (const option of offered) {
    assert.ok(
      (ALLERGEN_TERMS[option]?.length ?? 0) > 0,
      `no allergen terms for the offered option ${JSON.stringify(option)}`,
    );
  }
});

/**
 * The specific misses the split caused. Each of these was caught by one
 * pipeline and waved through by the other.
 */
const CROSS_PIPELINE_MISSES: readonly [string, string][] = [
  ["2 tbsp teriyaki sauce", "Soy"],
  ["1 tsp dijon mustard", "Mustard"],
  ["1/2 cup hummus", "Sesame"],
  ["2 tbsp soy sauce", "Wheat or gluten"],
  ["4 oz feta cheese", "Milk or dairy"],
  ["1/2 cup mascarpone", "Milk or dairy"],
  ["1 cup orzo", "Wheat or gluten"],
  ["6 sheets phyllo dough", "Wheat or gluten"],
  ["1 cup buttermilk", "Milk or dairy"],
];

test("both pipelines now catch what only one of them used to", () => {
  for (const [line, allergy] of CROSS_PIPELINE_MISSES) {
    assert.equal(
      containsAllergen([parseIngredientLine(line)], [allergy]),
      allergy,
      `recipe pipeline missed ${allergy} in ${JSON.stringify(line)}`,
    );
    assert.equal(
      violatesAllergies({ title: line, itemTerms: [] }, [allergy]),
      true,
      `coupon pipeline missed ${allergy} in ${JSON.stringify(line)}`,
    );
  }
});

test("a clean line still passes both", () => {
  assert.equal(containsAllergen([parseIngredientLine("1 onion, diced")], ["Soy"]), null);
  assert.equal(violatesAllergies({ title: "2 for $6 onions", itemTerms: [] }, ["Soy"]), false);
});
