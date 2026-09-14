/**
 * The JSON-LD path, which is the whole reason the recipe pipeline is nearly
 * free: every allowlisted site publishes its ingredients as structured data for
 * Google, so reading them costs no model tokens. When this breaks, the pipeline
 * silently falls through to the paid extractor.
 */

import { test } from "vitest";
import assert from "node:assert/strict";

import { LOOKS_LIKE_ROUNDUP } from "../convex/recipeCatalog.ts";
import {
  extractJsonLdBlocks,
  findRecipeNode,
  ingredientsFromMarkdown,
  parseIso8601Duration,
  recipeFromHtml,
  recipeFromNode,
} from "../convex/recipeJsonLd.ts";

const RECIPE = {
  "@context": "https://schema.org",
  "@type": "Recipe",
  name: "Garlic Butter Chicken",
  image: ["https://example.com/a.jpg"],
  totalTime: "PT45M",
  recipeYield: ["4 servings"],
  recipeIngredient: ["2 lb chicken thighs", "4 cloves garlic", "3 tbsp butter"],
};

function page(payload: unknown, attrs = 'type="application/ld+json"'): string {
  return `<html><head><script ${attrs}>${JSON.stringify(payload)}</script></head><body></body></html>`;
}

test("a plain Recipe block parses end to end", () => {
  const parsed = recipeFromHtml(page(RECIPE));
  assert.notEqual(parsed, null);
  assert.equal(parsed?.name, "Garlic Butter Chicken");
  assert.equal(parsed?.totalTimeMinutes, 45);
  assert.equal(parsed?.servings, "4 servings");
  assert.deepEqual(parsed?.ingredientsRaw, [
    "2 lb chicken thighs",
    "4 cloves garlic",
    "3 tbsp butter",
  ]);
  assert.equal(parsed?.image, "https://example.com/a.jpg");
});

test("the Recipe is found inside a Yoast @graph", () => {
  const parsed = recipeFromHtml(
    page({ "@graph": [{ "@type": "WebPage" }, { "@type": "Organization" }, RECIPE] }),
  );
  assert.equal(parsed?.name, "Garlic Butter Chicken");
});

test("the Recipe is found inside a top-level array and inside itemListElement", () => {
  assert.equal(recipeFromHtml(page([{ "@type": "BreadcrumbList" }, RECIPE]))?.name, RECIPE.name);
  assert.equal(
    recipeFromHtml(page({ "@type": "ItemList", itemListElement: [RECIPE] }))?.name,
    RECIPE.name,
  );
});

test("an @type array containing Recipe still counts", () => {
  const parsed = recipeFromHtml(page({ ...RECIPE, "@type": ["Recipe", "NewsArticle"] }));
  assert.equal(parsed?.name, RECIPE.name);
});

test("single quotes and extra attributes on the script tag are handled", () => {
  assert.notEqual(recipeFromHtml(page(RECIPE, "type='application/ld+json'")), null);
  assert.notEqual(
    recipeFromHtml(page(RECIPE, 'data-id="x" type = "application/ld+json" defer')),
    null,
  );
});

test("one malformed block does not lose a good one", () => {
  const html =
    `<script type="application/ld+json">{ not json </script>` +
    `<script type="application/ld+json">${JSON.stringify(RECIPE)}</script>`;
  assert.equal(extractJsonLdBlocks(html).length, 1);
  assert.equal(recipeFromHtml(html)?.name, RECIPE.name);
});

test("CDATA and comment guards are stripped before parsing", () => {
  const wrapped = `<script type="application/ld+json">//<![CDATA[
${JSON.stringify(RECIPE)}
//]]></script>`;
  assert.equal(recipeFromHtml(wrapped)?.name, RECIPE.name);
});

test("a page with no Recipe returns null rather than a half-built one", () => {
  assert.equal(recipeFromHtml("<html><body>no structured data</body></html>"), null);
  assert.equal(recipeFromHtml(page({ "@type": "Article", name: "Not a recipe" })), null);
  assert.equal(findRecipeNode([]), null);
  assert.equal(recipeFromNode(null), null);
});

test("a Recipe with no ingredients is not a usable Recipe", () => {
  const { recipeIngredient, ...withoutIngredients } = RECIPE;
  assert.equal(recipeIngredient.length, 3);
  assert.equal(recipeFromHtml(page(withoutIngredients)), null);
  assert.equal(recipeFromHtml(page({ ...withoutIngredients, recipeIngredient: [] })), null);
});

test("ingredient lines are whitespace-collapsed and blanks dropped", () => {
  const parsed = recipeFromHtml(
    page({ ...RECIPE, recipeIngredient: ["  2   lb\n chicken ", "", "   ", "salt"] }),
  );
  assert.deepEqual(parsed?.ingredientsRaw, ["2 lb chicken", "salt"]);
});

test("both ISO-8601 duration shapes found in the wild parse", () => {
  assert.equal(parseIso8601Duration("PT105M"), 105, "Budget Bytes writes minutes");
  assert.equal(parseIso8601Duration("PT2700S"), 45, "The Kitchn writes seconds");
  assert.equal(parseIso8601Duration("PT1H30M"), 90);
  assert.equal(parseIso8601Duration("P1DT2H"), 1560);
});

test("a duration we cannot trust becomes nothing rather than a wrong number", () => {
  for (const bad of ["", "45 minutes", "PT0M", undefined, 45, null]) {
    assert.equal(parseIso8601Duration(bad), undefined, `expected undefined for ${String(bad)}`);
  }
});

test("totalTime is preferred, then cookTime, then prepTime", () => {
  const { totalTime, ...rest } = RECIPE;
  assert.equal(totalTime, "PT45M");
  assert.equal(recipeFromHtml(page({ ...rest, cookTime: "PT20M" }))?.totalTimeMinutes, 20);
  assert.equal(recipeFromHtml(page({ ...rest, prepTime: "PT10M" }))?.totalTimeMinutes, 10);
});

test("recipeYield takes the first scalar, whatever shape it arrives in", () => {
  assert.equal(recipeFromHtml(page({ ...RECIPE, recipeYield: 6 }))?.servings, "6");
  assert.equal(recipeFromHtml(page({ ...RECIPE, recipeYield: ["8", "8 slices"] }))?.servings, "8");
});

test("image survives string, object, and array forms", () => {
  assert.equal(recipeFromHtml(page({ ...RECIPE, image: "https://e.com/x.jpg" }))?.image, "https://e.com/x.jpg");
  assert.equal(
    recipeFromHtml(page({ ...RECIPE, image: { "@type": "ImageObject", url: "https://e.com/y.jpg" } }))?.image,
    "https://e.com/y.jpg",
  );
});

test("the free markdown fallback reads the list under an ingredients heading", () => {
  const markdown = [
    "# Garlic Butter Chicken",
    "Some intro prose.",
    "## Ingredients",
    "- 2 lb chicken thighs",
    "* 4 cloves [garlic](https://example.com/garlic)",
    "1. 3 tbsp **butter**",
    "",
    "## Instructions",
    "- Heat the pan.",
  ].join("\n");

  assert.deepEqual(ingredientsFromMarkdown(markdown), [
    "2 lb chicken thighs",
    "4 cloves garlic",
    "3 tbsp butter",
  ]);
});

test("the markdown fallback gives up cleanly when there is no heading", () => {
  assert.deepEqual(ingredientsFromMarkdown("# Chicken\n- 2 lb chicken"), []);
});

test("the markdown fallback skips prose that happens to be bulleted", () => {
  const long = "x".repeat(150);
  const markdown = ["## Ingredients", `- ${long}`, "- salt"].join("\n");
  assert.deepEqual(ingredientsFromMarkdown(markdown), ["salt"]);
});

// --------------------------------------------------- what is not one recipe

test("category, tag and meal-plan pages are recognised as roundups", () => {
  // All three reached a live run, were paid for, and produced no recipe: a
  // category index has no ingredient list to find.
  for (const url of [
    "https://www.budgetbytes.com/category/recipes/global/mediterranean/",
    "https://www.budgetbytes.com/categories/dinner/",
    "https://www.thekitchn.com/mediterranean-diet-meal-plan-266965",
    "https://example.com/tag/salads/",
    "https://www.delish.com/g12345/easy-dinners/",
    "https://example.com/collections/weeknight/",
  ]) {
    assert.equal(LOOKS_LIKE_ROUNDUP.test(url), true, url);
  }
});

test("a single recipe page is not mistaken for a roundup", () => {
  for (const url of [
    "https://minimalistbaker.com/the-ultimate-mediterranean-bowl/",
    "https://www.skinnytaste.com/mediterranean-salmon-sheet-pan-dinner/",
    "https://www.food.com/recipe/buffalo-chicken-dip-79116",
    "https://www.thekitchn.com/best-buffalo-chicken-dip-recipe-23706997",
  ]) {
    assert.equal(LOOKS_LIKE_ROUNDUP.test(url), false, url);
  }
});
