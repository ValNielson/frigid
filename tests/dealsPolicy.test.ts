import { test } from "node:test";
import assert from "node:assert/strict";

import {
  couponDedupeKey,
  emailTextForModel,
  excludeAllergens,
  isDigestDue,
  isLikelyPromotional,
  isScrapeFresh,
  locationKey,
  matchIngredients,
  normalizeDomain,
  rawLocationKey,
  splitStores,
  stripHtml,
  violatesAllergies,
  MAX_EMAIL_CHARS,
  ON_DEMAND_ONLY,
} from "../convex/deals/policy.ts";

function coupon(title: string, details?: string, itemTerms: string[] = []) {
  return { title, details, itemTerms };
}

test("allergen exclusion catches the allergen wherever it is written", () => {
  const inTitle = coupon("2 for $6 Peanut Butter");
  const inDetails = coupon("Snack sale", "Includes peanut brittle");
  const inTerms = coupon("Mixed bulk bin", undefined, ["peanut"]);

  for (const c of [inTitle, inDetails, inTerms]) {
    assert.equal(violatesAllergies(c, ["Peanuts"]), true);
  }
});

test("allergen exclusion is case insensitive", () => {
  assert.equal(
    violatesAllergies(coupon("FRESH SHRIMP $8/LB"), ["Shellfish"]),
    true,
  );
});

test("a declared allergen we have no term list for still filters on its name", () => {
  // Free text from the onboarding "something else" box.
  assert.equal(
    violatesAllergies(coupon("Buckwheat pancake mix"), ["buckwheat"]),
    true,
  );
});

test("very short free-text allergies do not match everything", () => {
  // Guards the length check: a two-letter entry would otherwise hit most text.
  assert.equal(
    violatesAllergies(coupon("Ribeye steak, $9.99/lb"), ["ax"]),
    false,
  );
});

test("unrelated coupons survive", () => {
  assert.equal(
    violatesAllergies(coupon("Bananas 49c/lb"), ["Peanuts", "Shellfish"]),
    false,
  );
});

test("excludeAllergens drops only the offending coupons and keeps order", () => {
  const coupons = [
    coupon("Bananas 49c/lb"),
    coupon("Whole milk gallon $2.99"),
    coupon("Russet potatoes 5lb"),
    coupon("Cheddar block $4"),
  ];

  const safe = excludeAllergens(coupons, ["Milk or dairy"]);
  assert.deepEqual(
    safe.map((c) => c.title),
    ["Bananas 49c/lb", "Russet potatoes 5lb"],
  );
});

test("no declared allergies excludes nothing", () => {
  const coupons = [coupon("Shrimp ring"), coupon("Peanut brittle")];
  assert.equal(excludeAllergens(coupons, []).length, 2);
});

test("exclusion errs toward withholding rather than letting one through", () => {
  // "butternut" contains "butter". Over-exclusion is the intended direction:
  // a suppressed coupon is a coupon, a missed allergen is a health incident.
  assert.equal(
    violatesAllergies(coupon("Butternut squash"), ["Milk or dairy"]),
    true,
  );
});

test("promotional prefilter passes known merchants regardless of subject", () => {
  const known = new Set(["meijer.com"]);
  assert.equal(
    isLikelyPromotional(
      { from: "news@email.meijer.com", subject: "Hello" },
      known,
    ),
    true,
  );
});

test("promotional prefilter passes promo subjects from unknown senders", () => {
  assert.equal(
    isLikelyPromotional(
      { from: "hi@somebakery.com", subject: "20% off this week" },
      new Set(),
    ),
    true,
  );
});

test("promotional prefilter rejects ordinary mail, which is what makes it free", () => {
  assert.equal(
    isLikelyPromotional(
      { from: "mom@example.com", subject: "dinner sunday?" },
      new Set(),
    ),
    false,
  );
});

test("stripHtml removes script and style content, not just tags", () => {
  const html =
    "<style>.a{color:red}</style><p>Buy one<script>evil()</script> get one</p>";
  assert.equal(stripHtml(html), "Buy one get one");
});

test("stripHtml decodes the entities marketing mail actually uses", () => {
  assert.equal(
    stripHtml("<p>Ben &amp; Jerry&#39;s&nbsp;half off</p>"),
    "Ben & Jerry's half off",
  );
});

test("email text prefers extracted text and caps length", () => {
  const long = "a".repeat(MAX_EMAIL_CHARS + 500);
  assert.equal(
    emailTextForModel({ extractedText: long }).length,
    MAX_EMAIL_CHARS,
  );
});

test("email text falls back to html when text is absent", () => {
  // The common case: AgentMail omits `text` for HTML-only marketing mail.
  assert.equal(
    emailTextForModel({ extractedHtml: "<p>Weekly ad</p>" }),
    "Weekly ad",
  );
});

test("dedupe key is stable across whitespace and case drift", () => {
  assert.equal(
    couponDedupeKey("meijer.com", "2 for  $6  Cereal", "SAVE5"),
    couponDedupeKey("meijer.com", "2 For $6 Cereal", "save5"),
  );
});

test("dedupe key separates different merchants offering the same thing", () => {
  assert.notEqual(
    couponDedupeKey("meijer.com", "Eggs $2"),
    couponDedupeKey("kroger.com", "Eggs $2"),
  );
});

test("normalizeDomain reduces a url to an identity", () => {
  for (const raw of [
    "https://www.Meijer.com/weeklyad?x=1",
    "meijer.com",
    "HTTP://meijer.com/",
  ]) {
    assert.equal(normalizeDomain(raw), "meijer.com");
  }
});

test("normalizeDomain rejects things that are not domains", () => {
  assert.equal(normalizeDomain(""), null);
  assert.equal(normalizeDomain("not a domain"), null);
});

test("location spellings collapse to one cache key", () => {
  assert.equal(
    rawLocationKey("  Grand   Rapids, MI "),
    rawLocationKey("grand rapids, mi"),
  );
  assert.equal(locationKey("Grand Rapids", "MI"), "grand rapids, mi");
});

test("ingredient matching finds coupons naming any ingredient", () => {
  const coupons = [
    coupon("Boneless chicken thighs $1.99/lb", undefined, ["chicken"]),
    coupon("Bananas 49c/lb", undefined, ["banana"]),
    coupon("Limes 3/$1", undefined, ["lime"]),
  ];

  const hits = matchIngredients(coupons, ["chicken thighs", "lime", "saffron"]);
  assert.deepEqual(
    hits.map((c) => c.itemTerms[0]),
    ["chicken", "lime"],
  );
});

test("ingredient matching ignores noise words and empty input", () => {
  const coupons = [coupon("Bananas", undefined, ["banana"])];
  assert.equal(matchIngredients(coupons, ["a", "of", ""]).length, 0);
  assert.equal(matchIngredients(coupons, []).length, 0);
});

test("scrape freshness respects the ttl boundary", () => {
  const now = 1_000_000_000_000;
  assert.equal(isScrapeFresh(undefined, now), false);
  assert.equal(isScrapeFresh(now - 60_000, now), true);
  assert.equal(isScrapeFresh(now - 25 * 60 * 60 * 1000, now), false);
});

test("the on-demand opt-out is never mailed by the cron", () => {
  const now = 1_000_000_000_000;
  assert.equal(isDigestDue(ON_DEMAND_ONLY, undefined, now), false);
  assert.equal(
    isDigestDue(ON_DEMAND_ONLY, now - 365 * 24 * 60 * 60 * 1000, now),
    false,
  );
});

test("a user who has never been mailed is due, unless they opted out", () => {
  const now = 1_000_000_000_000;
  assert.equal(isDigestDue("Once a week", undefined, now), true);
});

test("digest cadence honours the chosen interval", () => {
  const now = 1_000_000_000_000;
  const day = 24 * 60 * 60 * 1000;

  assert.equal(isDigestDue("Every day", now - 2 * day, now), true);
  assert.equal(isDigestDue("Every day", now - 3600_000, now), false);
  assert.equal(isDigestDue("Once a week", now - 3 * day, now), false);
  assert.equal(isDigestDue("Once a week", now - 8 * day, now), true);
  assert.equal(isDigestDue("Once a month", now - 31 * day, now), true);
});

test("an unknown or missing frequency does not start mailing people", () => {
  const now = 1_000_000_000_000;
  assert.equal(isDigestDue(undefined, undefined, now), false);
  assert.equal(isDigestDue("Twice an hour", undefined, now), false);
});

// Titles and terms below are verbatim from a live Firecrawl extraction of
// aldi.us, so the safety rule is exercised against the shape of data the
// pipeline actually receives rather than invented examples.
const REAL_COUPONS = [
  {
    title: "Emporium Selection Bacon Bread Cheese",
    itemTerms: ["bacon", "bread", "cheese"],
  },
  {
    title: "Simply Nature Organic Raspberry Sweet Tea",
    itemTerms: ["raspberry", "tea"],
  },
  {
    title: "Specially Selected Wild Caught Ahi Tuna Steaks",
    itemTerms: ["ahi", "tuna", "steak"],
  },
  {
    title: "Simply Nature Organic Jasmine Rice",
    itemTerms: ["jasmine", "rice"],
  },
  {
    title: "Burman's Teriyaki Stir Fry Sauce",
    itemTerms: ["teriyaki", "sauce"],
  },
  { title: "Chef's Cupboard Chicken Broth", itemTerms: ["chicken", "broth"] },
  {
    title: "Benton's Orange Jaffa Cakes",
    itemTerms: ["orange", "jaffa", "cake"],
  },
];

test("real extracted coupons: dairy allergy withholds the cheese", () => {
  const safe = excludeAllergens(REAL_COUPONS, ["Milk or dairy"]);
  const titles = safe.map((c) => c.title);
  assert.ok(!titles.includes("Emporium Selection Bacon Bread Cheese"));
  assert.ok(titles.includes("Simply Nature Organic Jasmine Rice"));
});

test("real extracted coupons: fish allergy withholds the tuna", () => {
  const safe = excludeAllergens(REAL_COUPONS, ["Fish"]);
  assert.ok(!safe.some((c) => c.title.includes("Tuna")));
  assert.ok(safe.some((c) => c.title.includes("Jasmine Rice")));
});

test("real extracted coupons: soy allergy catches teriyaki, which never says soy", () => {
  // The word "soy" appears nowhere in the title or the terms. Matching on the
  // dish name is the only thing that catches it.
  const safe = excludeAllergens(REAL_COUPONS, ["Soy"]);
  assert.ok(!safe.some((c) => c.title.includes("Teriyaki")));
});

test("real extracted coupons: a clean profile keeps everything", () => {
  assert.equal(
    excludeAllergens(REAL_COUPONS, ["Peanuts"]).length,
    REAL_COUPONS.length,
  );
});

test("known trade-off: 'gluten free' trips the gluten rule", () => {
  // Over-exclusion in the safe direction, and a real cost: a coeliac user loses
  // the gluten-free pasta deal they most wanted. Negation matching would fix it
  // and would also be the thing that lets real gluten through, so the rule
  // stands as written and this test pins the behaviour rather than hiding it.
  const glutenFreePasta = {
    title: "Simply Nature Gluten Free Chickpea Rotini",
    itemTerms: ["chickpea", "rotini"],
  };
  assert.equal(violatesAllergies(glutenFreePasta, ["Wheat or gluten"]), true);
});

test("known chains resolve without the planner, which is the cost win", () => {
  const { domains, vague } = splitStores(["Kroger", "Meijer", "Aldi"]);
  assert.deepEqual(domains, ["kroger.com", "meijer.com", "aldi.us"]);
  assert.equal(vague.length, 0);
});

test("only category options and write-ins reach the planner", () => {
  const { domains, vague } = splitStores([
    "Meijer",
    "Local co-op or farmers market",
    "Ferris Coffee",
  ]);
  assert.deepEqual(domains, ["meijer.com"]);
  assert.deepEqual(vague, ["Local co-op or farmers market", "Ferris Coffee"]);
});

test("empty store answers produce no work", () => {
  assert.deepEqual(splitStores([]), { domains: [], vague: [] });
  assert.deepEqual(splitStores(["  "]), { domains: [], vague: [] });
});
