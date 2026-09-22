/**
 * The starter chips, checked against real search output.
 *
 * "Plan five dinners" shipped broken: its prompt asked for a meal plan, search
 * could only answer with listicles, and every run failed after paying to scrape
 * four of them. Nothing caught that, because nothing exercised the prompts.
 *
 * The URL lists below are verbatim Firecrawl results pulled from `searchCache`
 * on the dev deployment, so this asserts against what the search engine really
 * returns rather than against invented URLs.
 */

import { test } from "vitest";
import assert from "node:assert/strict";

import {
  buildSearchQuery,
  domainOf,
  sharesPromptWord,
} from "../convex/recipeText.ts";
import { LOOKS_LIKE_ROUNDUP, RECIPE_DOMAINS } from "../convex/recipeCatalog.ts";
import { MIN_PROMPT_LENGTH, MAX_PROMPT_LENGTH } from "../convex/recipePolicy.ts";

/** Kept in step with STARTERS in app/components/RecipeSearchCard.tsx. */
const STARTER_PROMPTS = [
  "something with chicken thighs, rice, and a lemon",
  "easy chicken dinners for two",
  "a quick vegetarian pasta",
];

/** The placeholder, which users read as a suggestion and type variations of. */
const PLACEHOLDER = "something warm with chicken";

const PROFILE = {
  diet: { choices: ["No restrictions"] },
  weeknightTime: { choices: ["Under 20 minutes"] },
};

const onAllowlist = (url: string) => {
  const domain = domainOf(url);
  return RECIPE_DOMAINS.some((a) => domain === a || domain.endsWith(`.${a}`));
};

/** What survives to be scraped: allowlisted, not a roundup, on topic. */
const usable = (urls: readonly string[], prompt: string) =>
  urls
    .filter(onAllowlist)
    .filter((url) => !LOOKS_LIKE_ROUNDUP.test(url))
    .filter((url) => sharesPromptWord({ title: url }, prompt));

test("every starter prompt is a searchable dish, not a request for a plan", () => {
  for (const prompt of [...STARTER_PROMPTS, PLACEHOLDER]) {
    assert.ok(prompt.length >= MIN_PROMPT_LENGTH, prompt);
    assert.ok(prompt.length <= MAX_PROMPT_LENGTH, prompt);

    const query = buildSearchQuery(prompt, PROFILE);
    assert.match(query, /\brecipe\b/, `${prompt} -> ${query}`);

    // A bare count with no dish is what made "five weeknight dinners for two"
    // return nothing but listicles.
    assert.doesNotMatch(
      query,
      /\b(?:five|four|seven|meal plan|week of)\b/i,
      `${prompt} reads as a meal plan, which search can only answer with roundups`,
    );
    // Numbers and time words are not foods, and search treats them as if they were.
    assert.doesNotMatch(query, /\b\d+\b/, `${prompt} -> ${query} carries a bare number`);
  }
});

/** Verbatim Firecrawl results, from searchCache on the dev deployment. */
const REAL_RESULTS: { prompt: string; urls: string[] }[] = [
  {
    prompt: "easy chicken dinners for two",
    urls: [
      "https://www.tablefortwoblog.com/20-easy-chicken-dinners-for-busy-weeknights/",
      "https://cooking.nytimes.com/article/reader-favorite-easy-quick-chicken-recipes",
      "https://www.delish.com/cooking/recipe-ideas/g71297511/weeknight-chicken-dinners/",
      "https://www.thekitchn.com/melt-in-your-mouth-chicken-recipe-23752472",
      "https://www.thekitchn.com/tuscan-chicken-recipe-23624913",
      "https://simplehomeedit.com/category/mains/chicken/",
      "https://www.youtube.com/watch?v=K_85yJDrAuw",
      "https://www.halfbakedharvest.com/honey-garlic-chicken/",
      "https://www.thekitchn.com/shredded-chicken-recipes-23590104",
    ],
  },
  {
    prompt: "something warm with chicken",
    urls: [
      "https://www.bonappetit.com/recipes/chicken/slideshow/boneless-skinless-chicken-breast-recipes",
      "https://www.thekitchn.com/shredded-chicken-recipes-23590104",
      "https://www.halfbakedharvest.com/honey-garlic-chicken/",
      "https://www.recipetineats.com/category/chicken-recipes/",
      "https://www.delish.com/cooking/recipe-ideas/g71297511/weeknight-chicken-dinners/",
      "https://www.thekitchn.com/melt-in-your-mouth-chicken-recipe-23752472",
      "https://www.delish.com/cooking/g65252389/summer-chicken-recipe-ideas/",
    ],
  },
  {
    prompt: "a quick vegetarian pasta",
    urls: [
      "https://www.thekitchn.com/one-pot-pasta-recipes-261459",
      "https://www.loveandlemons.com/pasta-recipes/",
      "https://www.thekitchn.com/collection/pasta",
      "https://www.delish.com/cooking/g4627/italian-pasta-recipes/",
      "https://www.thekitchn.com/11-pasta-dinners-that-dont-involve-red-sauce-236557",
      "https://www.bonappetit.com/gallery/best-pasta-recipes",
      "https://www.halfbakedharvest.com/marry-me-chicken-pasta/",
      "https://www.delish.com/cooking/recipe-ideas/g3053/baked-pasta/",
      "https://www.loveandlemons.com/pasta-primavera/",
    ],
  },
];

test("each starter still finds real recipes once the filters have run", () => {
  for (const { prompt, urls } of REAL_RESULTS) {
    const kept = usable(urls, prompt);
    // Two is the floor worth shipping: one recipe is not a shopping list, and
    // zero is the failure the roundup filter exists to prevent.
    assert.ok(
      kept.length >= 2,
      `"${prompt}" keeps only ${kept.length} of ${urls.length}: ${kept.join(", ")}`,
    );
    for (const url of kept) {
      assert.ok(!/\/(?:gallery|collection|slideshow)\//.test(url), url);
    }
  }
});

test("a Hearst gallery is rejected however short its id", () => {
  // /g3053/ and /g4627/ both slipped a five-digit rule while /g71297511/ did not.
  assert.ok(LOOKS_LIKE_ROUNDUP.test("https://www.delish.com/cooking/recipe-ideas/g3053/baked-pasta/"));
  assert.ok(LOOKS_LIKE_ROUNDUP.test("https://www.delish.com/cooking/g4627/italian-pasta-recipes/"));
  assert.ok(LOOKS_LIKE_ROUNDUP.test("https://www.delish.com/cooking/recipe-ideas/g71297511/weeknight-chicken-dinners/"));
  // A single recipe uses /a<id>/ and must survive.
  assert.ok(!LOOKS_LIKE_ROUNDUP.test("https://www.delish.com/cooking/recipe-ideas/a44475588/best-chicken-soup-recipe/"));
});
