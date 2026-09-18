/**
 * What the recipe email actually says.
 *
 * The deals section is the reason these exist. Coupons were proven as far as
 * the job row and no further, so every test that mattered passed while the
 * question people actually ask — did the deal reach the inbox — went unasked.
 *
 * Both renderers are checked together throughout: the text and HTML parts are
 * the same message, and a deal that reaches one body but not the other is a
 * half-sent answer rather than a formatting detail.
 */

import { test } from "vitest";
import assert from "node:assert/strict";

import {
  renderRecipeHtml,
  renderRecipeText,
  type RecipeEmailPayload,
} from "../convex/recipeEmail.ts";

const OPT_OUT = "https://frigid.example/unsubscribe?token=abc";

const RECIPE = {
  url: "https://www.thekitchn.com/buffalo-chicken-dip-23745120",
  name: "Buffalo Chicken Dip",
  totalTimeMinutes: 35,
  servings: "8",
  ingredients: [
    { raw: "2 lb chicken thighs", item: "chicken thighs", quantity: "2 lb" },
    { raw: "8 oz cream cheese", item: "cream cheese", quantity: "8 oz" },
  ],
};

const SHOPPING = [
  {
    item: "chicken thighs",
    usedIn: ["Buffalo Chicken Dip"],
    department: "Meat & Seafood",
    stores: [
      {
        storeSlug: "kroger",
        storeLabel: "Kroger",
        searchUrl: "https://www.kroger.com/search?query=chicken%20thighs",
      },
    ],
  },
];

function payload(deals?: RecipeEmailPayload["deals"]): RecipeEmailPayload {
  return {
    prompt: "something with chicken",
    recipes: [RECIPE],
    shopping: SHOPPING,
    ...(deals === undefined ? {} : { deals }),
  };
}

const DEAL = {
  title: "Chicken thighs, family pack",
  discount: "$1.99/lb",
  code: "SAVE5",
  sourceUrl: "https://www.kroger.com/weekly-ad",
  merchantName: "Kroger",
};

// ------------------------------------------------------------- the deals section

test("a matched deal reaches both bodies", () => {
  const text = renderRecipeText(payload([DEAL]));
  const html = renderRecipeHtml(payload([DEAL]), OPT_OUT);

  assert.match(text, /ON SALE FOR THIS LIST/);
  assert.match(text, /Chicken thighs, family pack/);
  assert.match(text, /\$1\.99\/lb/);
  assert.match(text, /at Kroger/);
  assert.match(text, /Code: SAVE5/);
  assert.match(text, /https:\/\/www\.kroger\.com\/weekly-ad/);

  assert.match(html, /On sale for this list/);
  assert.match(html, /Chicken thighs, family pack/);
  assert.match(html, /\$1\.99\/lb/);
  assert.match(html, /at Kroger/);
  assert.match(html, /SAVE5/);
  assert.match(html, /href="https:\/\/www\.kroger\.com\/weekly-ad"/);
});

test("a deal carrying only a title still prints", () => {
  const bare = { title: "Buy one get one on cream cheese" };
  assert.match(renderRecipeText(payload([bare])), /Buy one get one on cream cheese/);
  assert.match(renderRecipeHtml(payload([bare]), OPT_OUT), /Buy one get one on cream cheese/);
});

test("several deals all print rather than only the first", () => {
  const deals = [DEAL, { title: "Celery, 2 for $3" }, { title: "Cream cheese, 99c" }];
  const text = renderRecipeText(payload(deals));
  const html = renderRecipeHtml(payload(deals), OPT_OUT);

  for (const deal of deals) {
    assert.ok(text.includes(deal.title), `text is missing ${deal.title}`);
    assert.ok(html.includes(deal.title), `html is missing ${deal.title}`);
  }
});

// ------------------------------------------------------- when there are none

/**
 * `deals` is optional on the payload because jobs predating the deals step do
 * not carry it. Neither absence may print an empty heading — a section titled
 * "on sale" with nothing under it reads as a bug in the email.
 */
test("no deals prints no section, whether the field is empty or absent", () => {
  for (const none of [[], undefined]) {
    const text = renderRecipeText(payload(none));
    const html = renderRecipeHtml(payload(none), OPT_OUT);
    assert.doesNotMatch(text, /ON SALE/);
    assert.doesNotMatch(html, /On sale for this list/);
    // The recipes still have to be there: deals are the bonus, not the answer.
    assert.match(text, /Buffalo Chicken Dip/);
    assert.match(html, /Buffalo Chicken Dip/);
  }
});

// -------------------------------------------------------------- untrusted input

/**
 * Coupon fields are scraped, so they are attacker-shaped by default. The title
 * goes through escapeHtml and the source URL through safeHref; a javascript:
 * scheme must cost the link, never the deal.
 */
test("a non-http source url drops the link but keeps the deal", () => {
  const nasty = { title: "Free soap", sourceUrl: "javascript:alert(1)" };
  const text = renderRecipeText(payload([nasty]));
  const html = renderRecipeHtml(payload([nasty]), OPT_OUT);

  assert.match(text, /Free soap/);
  assert.doesNotMatch(text, /javascript:/);
  assert.match(html, /Free soap/);
  assert.doesNotMatch(html, /javascript:/);
});

test("markup in a coupon title is escaped, not rendered", () => {
  const html = renderRecipeHtml(
    payload([{ title: "<script>alert(1)</script> chicken" }]),
    OPT_OUT,
  );
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

// ------------------------------------------------------------------ the basics

test("the prompt, the recipe link and the shopping list all survive", () => {
  const text = renderRecipeText(payload([DEAL]));
  const html = renderRecipeHtml(payload([DEAL]), OPT_OUT);

  assert.match(text, /something with chicken/);
  assert.match(text, /WHAT TO SHOP FOR/);
  assert.match(text, /Chicken thighs/);
  assert.ok(text.includes(RECIPE.url), "text is missing the recipe link");

  assert.match(html, /something with chicken/);
  assert.match(html, /What to shop for/);
  assert.ok(html.includes(RECIPE.url), "html is missing the recipe link");
  assert.ok(html.includes(OPT_OUT), "html is missing the unsubscribe link");
});

/** Documented as a deliberate rule: we never quote a price we did not check. */
test("no price is invented for a shopping item", () => {
  const text = renderRecipeText(payload());
  const shoppingPart = text.slice(text.indexOf("WHAT TO SHOP FOR"));
  assert.doesNotMatch(shoppingPart, /\$\d/);
});
