/**
 * Ingredient parsing, cache keys, and the allergen gate.
 *
 * The rules in recipeText.ts each name the real page that forced them — the
 * price tags are Budget Bytes, the numeric entities Cookie and Kate, the gram
 * parentheticals Sally's Baking Addiction. Those pages are the test cases.
 */

import { test } from "vitest";
import assert from "node:assert/strict";

import {
  buildSearchQuery,
  containsAllergen,
  decodeEntities,
  dedupeIngredients,
  domainOf,
  isPantryStaple,
  normalizeQuery,
  normalizeUrl,
  parseIngredientLine,
  scoreCandidate,
  slugifyItem,
} from "../convex/recipeText.ts";
import { departmentFor } from "../convex/recipeCatalog.ts";

const item = (line: string) => parseIngredientLine(line).item;

// ------------------------------------------------------------ ingredient lines

test("the quantity is split off and the food is what remains", () => {
  assert.deepEqual(parseIngredientLine("2 lb boneless, skinless chicken thighs"), {
    raw: "2 lb boneless, skinless chicken thighs",
    item: "chicken thighs",
    quantity: "2 lb",
  });
});

test("a mid-phrase comma keeps its descriptor, a trailing prep clause does not", () => {
  // "bone-in, skin-on" describes the thing; "melted" is an instruction.
  assert.equal(item("3 tablespoons butter, melted"), "butter");
  assert.equal(item("1 medium yellow onion, diced"), "yellow onion");
  assert.equal(item("2 cloves garlic, minced"), "garlic");
});

test("gram and metric parentheticals are dropped", () => {
  assert.deepEqual(parseIngredientLine("1/2 cup (120 ml) whole milk"), {
    raw: "1/2 cup (120 ml) whole milk",
    item: "milk",
    quantity: "1/2 cup",
  });
});

test("Budget Bytes price tags are stripped", () => {
  assert.equal(item("1 cup shredded cheddar cheese ($1.29)"), "cheddar cheese");
});

test("vulgar fractions and numeric entities both become plain quantities", () => {
  assert.deepEqual(parseIngredientLine("1 &frac12; cups all-purpose flour"), {
    raw: "1 1/2 cups all-purpose flour",
    item: "all-purpose flour",
    quantity: "1 1/2 cups",
  });
  assert.equal(parseIngredientLine("¼ cup olive oil").quantity, "1/4 cup");
});

test("a line is cut at the phrase that ends its useful part", () => {
  // Filtering word by word used to leave "salt and pepper to" behind.
  assert.equal(item("Salt and pepper to taste"), "salt and pepper");
  assert.equal(item("2 tbsp parsley, for garnish"), "parsley");
  // And both halves of a "plus" line used to run together.
  assert.equal(item("1 lemon, zested plus 2 tablespoons lemon juice"), "lemon");
});

test("the first of two alternatives is enough", () => {
  assert.equal(item("¼ cup olive oil or vegetable oil"), "olive oil");
});

test("stacked units are peeled off", () => {
  assert.deepEqual(parseIngredientLine("3 medium stalks celery"), {
    raw: "3 medium stalks celery",
    item: "celery",
    quantity: "3 medium",
  });
  assert.equal(item("1 (14.5 oz) can diced tomatoes"), "tomatoes");
});

test("known trade-off: a unit with no leading number survives into the item", () => {
  // "a pinch of salt" keeps "pinch". Harmless on a shopping list, and the fix
  // would mean treating a bare article as a quantity.
  assert.equal(item("a pinch of salt"), "pinch of salt");
});

test("a line with nothing countable still yields an item and no quantity", () => {
  assert.equal(parseIngredientLine("Fresh basil").quantity, undefined);
  assert.equal(item("Fresh basil"), "basil");
});

// --------------------------------------------------------------- cache shapes

test("normalizeUrl drops tracking, case, and www so two arrivals share a scrape", () => {
  const key = "budgetbytes.com/garlic-chicken";
  assert.equal(normalizeUrl("https://WWW.BudgetBytes.com/garlic-chicken/?utm_source=x"), key);
  assert.equal(normalizeUrl("http://budgetbytes.com/garlic-chicken"), key);
  assert.equal(normalizeUrl("https://budgetbytes.com/garlic-chicken/#recipe"), key);
});

test("normalizeUrl falls back to the raw string rather than throwing", () => {
  assert.equal(normalizeUrl("not a url"), "not a url");
});

test("domainOf strips www and returns empty for junk", () => {
  assert.equal(domainOf("https://www.Food.com/recipe/1"), "food.com");
  assert.equal(domainOf("nonsense"), "");
});

test("normalizeQuery sorts and de-stopwords, so phrasing does not fork the cache", () => {
  assert.equal(normalizeQuery("Something warm with chicken"), "chicken warm");
  assert.equal(
    normalizeQuery("Something warm with chicken"),
    normalizeQuery("with chicken warm something"),
  );
});

test("slugifyItem singularizes so one shelf is one key", () => {
  assert.equal(slugifyItem("Chicken Thighs"), "chicken-thigh");
  assert.equal(slugifyItem("tomatoes"), "tomato");
});

test("decodeEntities handles named, decimal, and hex forms", () => {
  assert.equal(decodeEntities("Mac &amp; cheese &#x2153; &frac34;"), "Mac & cheese ⅓ 3/4");
});

// --------------------------------------------------------------- search query

test("the search query is a template, so operators cannot be injected", () => {
  // Stripping non-alphanumerics is what stops a user steering our search budget
  // with site: or similar through the free-text box.
  assert.equal(buildSearchQuery("chicken site:evil.com", {}), "chicken site evil com recipe");
});

test("the search query always asks for a recipe, without saying it twice", () => {
  assert.match(buildSearchQuery("warm chicken", {}), /\brecipe\b/);
  assert.equal(buildSearchQuery("chicken recipe", {}).match(/\brecipe\b/g)?.length, 1);
});

test("candidate scoring prefers prompt matches and penalises roundups", () => {
  const base = { url: "https://food.com/a", title: "Garlic Butter Chicken", description: "" };
  const roundup = { url: "https://food.com/b", title: "25 best chicken recipes", description: "" };
  assert.ok(scoreCandidate(base, "garlic chicken", {}) > scoreCandidate(roundup, "garlic chicken", {}));
});

test("candidate scoring subtracts for a cuisine the user avoids", () => {
  const candidate = { url: "https://food.com/a", title: "Thai green curry", description: "" };
  const neutral = scoreCandidate(candidate, "curry", {});
  const avoided = scoreCandidate(candidate, "curry", {
    cuisinesAvoid: { choices: ["Thai"] },
  });
  assert.ok(avoided < neutral);
});

// ------------------------------------------------------------- shopping list

test("one ingredient across two recipes becomes one line that names both", () => {
  const recipes = [
    { name: "A", ingredients: [parseIngredientLine("1 onion"), parseIngredientLine("2 lb chicken thighs")] },
    { name: "B", ingredients: [parseIngredientLine("1 large onion, diced")] },
  ];
  const list = dedupeIngredients(recipes, departmentFor, []);

  const onion = list.find((entry) => entry.item.includes("onion"));
  assert.deepEqual(onion?.usedIn, ["A", "B"]);
  assert.equal(onion?.department, "Produce");
  assert.equal(list.filter((entry) => entry.item.includes("onion")).length, 1);
});

test("a recipe named twice is not counted twice", () => {
  const recipes = [
    { name: "A", ingredients: [parseIngredientLine("1 onion"), parseIngredientLine("2 onions")] },
  ];
  assert.deepEqual(dedupeIngredients(recipes, departmentFor, [])[0]?.usedIn, ["A"]);
});

test("declared pantry staples are left off the list", () => {
  const recipes = [
    { name: "A", ingredients: [parseIngredientLine("1 tsp salt"), parseIngredientLine("1 onion")] },
  ];
  const items = dedupeIngredients(recipes, departmentFor, ["Salt"]).map((entry) => entry.item);
  assert.ok(!items.some((entry) => entry.includes("salt")));
  assert.ok(items.some((entry) => entry.includes("onion")));
  assert.equal(isPantryStaple("salt", ["Salt"]), true);
  assert.equal(isPantryStaple("chicken", ["Salt"]), false);
});

test("departments route the obvious cases and default to Pantry", () => {
  assert.equal(departmentFor("chicken thighs"), "Meat & Seafood");
  assert.equal(departmentFor("milk"), "Dairy & Eggs");
  assert.equal(departmentFor("onion"), "Produce");
  assert.equal(departmentFor("saffron"), "Pantry");
});

// -------------------------------------------------------------- allergen gate

test("an allergen is caught through a word the line never spells out", () => {
  assert.equal(containsAllergen([parseIngredientLine("3 tbsp butter")], ["Milk or dairy"]), "Milk or dairy");
  assert.equal(containsAllergen([parseIngredientLine("2 tbsp teriyaki sauce")], ["Soy"]), "Soy");
});

test("a clean recipe passes, and no declared allergies means no gate", () => {
  assert.equal(containsAllergen([parseIngredientLine("1 onion")], ["Milk or dairy"]), null);
  assert.equal(containsAllergen([parseIngredientLine("3 tbsp butter")], []), null);
});

test("the gate reads the raw line, not the parsed item", () => {
  // "melted" is stripped from the item, but the allergen must still be found in
  // whatever the page actually wrote.
  const parsed = parseIngredientLine("2 tbsp unsalted butter, melted");
  assert.equal(parsed.item, "butter");
  assert.equal(containsAllergen([parsed], ["Milk or dairy"]), "Milk or dairy");
});

test("an allergy typed into the free-text box filters on its own name", () => {
  assert.equal(containsAllergen([parseIngredientLine("1 cup quinoa")], ["quinoa"]), "quinoa");
});

test("the explicit no-allergies answer is not treated as an allergen", () => {
  assert.equal(containsAllergen([parseIngredientLine("1 onion")], ["No food allergies"]), null);
});
