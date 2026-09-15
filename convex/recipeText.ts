/**
 * Turning messy recipe text into things we can search, cache and shop for.
 *
 * Every rule here exists because a real page needed it — the price tags come
 * from Budget Bytes, the numeric entities from Cookie and Kate, the gram
 * parentheticals from Sally's Baking Addiction. Pure functions, no imports
 * beyond the catalog, so this is all testable on saved strings.
 */

import {
  ALLERGEN_KEYWORDS,
  DIET_SEARCH_TERMS,
  TIME_SEARCH_TERMS,
} from "./recipeCatalog";
import { NO_ALLERGIES, type Answers } from "./onboardingQuestions";
import { singular } from "./words";

// ---------------------------------------------------------------- text basics

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  frac12: "1/2", frac13: "1/3", frac14: "1/4", frac23: "2/3", frac34: "3/4",
  deg: "", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', mdash: "-", ndash: "-",
};

/** Vulgar fractions arrive both as literal characters and numeric entities. */
const FRACTIONS: Record<string, string> = {
  "½": "1/2", "⅓": "1/3", "⅔": "2/3", "¼": "1/4", "¾": "3/4",
  "⅕": "1/5", "⅖": "2/5", "⅗": "3/5", "⅘": "4/5", "⅙": "1/6",
  "⅚": "5/6", "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8",
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z0-9]+);/gi, (whole, name: string) => NAMED_ENTITIES[name] ?? whole);
}

function normalizeFractions(input: string): string {
  return input.replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, (ch) => ` ${FRACTIONS[ch] ?? ch}`);
}

// ------------------------------------------------------------ cache key shapes

/**
 * Cache key for a page.
 *
 * Query parameters on recipe URLs are tracking, never content, so dropping
 * them is what lets two users arriving from different places share one cached
 * scrape. Returns a bare host+path, which is also readable in the dashboard.
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = decodeURIComponent(parsed.pathname).replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "with", "to", "in", "on", "my",
  "me", "i", "some", "something", "anything", "want", "would", "like", "need",
  "make", "cook", "please", "that", "this", "is", "are", "it", "can", "give",
]);

/**
 * Cache key for a search.
 *
 * Tokens are sorted, so "warm chicken something" and "something warm chicken"
 * are one cache entry rather than two. That matters more than it sounds: free
 * text is how users phrase the same request a dozen ways.
 */
export function normalizeQuery(query: string): string {
  const tokens = decodeEntities(query)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));

  return [...new Set(tokens)].sort().join(" ").slice(0, 200);
}

// ------------------------------------------------------------- the search query

/**
 * Builds the query we send to Firecrawl, from a template rather than a model.
 *
 * Stripping non-alphanumerics does double duty: it tidies the query and it
 * means a user cannot inject `site:` or other operators through the free-text
 * box and steer our search budget somewhere we did not choose.
 *
 * Stopwords go before the cap, not after. Capping the raw words counted "give
 * me some ... to help me use up my" against the limit and dropped the word the
 * whole request was about: "give me some recipes to help me use up my tomatoes"
 * searched for weeknight roundups, because the eleventh word was the only one
 * that named a food. Politeness should not cost a user their subject.
 */
export function buildSearchQuery(prompt: string, answers: Answers): string {
  const cleaned = decodeEntities(prompt)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOPWORDS.has(word))
    .slice(0, 20)
    .join(" ");

  const parts = [cleaned];

  const diets = answers["diet"]?.choices ?? [];
  for (const diet of diets) {
    const term = DIET_SEARCH_TERMS[diet];
    if (term !== undefined) parts.push(term);
  }

  const time = answers["weeknightTime"]?.choices[0];
  if (time !== undefined) {
    const term = TIME_SEARCH_TERMS[time];
    if (term !== undefined) parts.push(term);
  }

  if (!/\brecipes?\b/.test(cleaned)) parts.push("recipe");

  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
}

// --------------------------------------------------------- ingredient parsing

const UNITS = [
  "cups?", "c", "tablespoons?", "tbsps?", "tbs", "tbsp", "teaspoons?", "tsps?", "tsp",
  "ounces?", "oz", "pounds?", "lbs?", "lb", "grams?", "g", "kilograms?", "kg",
  "milliliters?", "ml", "liters?", "l", "pints?", "quarts?", "qts?", "gallons?",
  "cloves?", "cans?", "jars?", "packages?", "pkgs?", "bunches?", "sprigs?",
  "slices?", "sticks?", "heads?", "ribs?", "stalks?", "pinch(?:es)?", "dashes?",
  "dash", "handfuls?", "pieces?", "strips?", "fillets?", "boxes?", "bags?",
  "containers?", "batch(?:es)?", "large", "medium", "small",
].join("|");

const QUANTITY = String.raw`\d+(?:[./]\d+)?(?:\s*[-–to]+\s*\d+(?:[./]\d+)?)?`;

/** Prep words that describe what you do to a thing, not which thing to buy. */
const PREP_WORDS = new Set([
  "chopped", "diced", "minced", "sliced", "grated", "shredded", "crushed",
  "melted", "softened", "beaten", "peeled", "trimmed", "rinsed", "drained",
  "cooked", "uncooked", "raw", "fresh", "freshly", "frozen", "dried", "ground",
  "finely", "roughly", "coarsely", "thinly", "halved", "quartered", "cubed",
  "julienned", "divided", "packed", "sifted", "room", "temperature", "optional",
  "plus", "more", "taste", "needed", "serving", "garnish", "cut", "torn",
  "washed", "scrubbed", "stemmed", "seeded", "cored", "pitted", "zested",
  "juiced", "toasted", "roasted", "warmed", "chilled", "thawed", "about",
  "shaved", "squeezed", "crumbled", "lightly", "well", "whole", "boneless",
  "skinless", "unsalted", "salted", "extra", "virgin", "pure", "good",
  "quality", "preferably", "such", "as", "your", "favorite", "store", "bought",
]);

/**
 * Words that begin a trailing clause describing preparation rather than a
 * different product. Cutting at the first comma is wrong — "2 lb bone-in,
 * skin-on chicken pieces" would become "bone-in" — so we drop comma-separated
 * segments from the end while they look like instructions.
 */
const TRAILING_CLAUSE_STARTERS = new Set([
  "chopped", "diced", "minced", "sliced", "grated", "shredded", "crushed",
  "melted", "softened", "beaten", "peeled", "trimmed", "rinsed", "drained",
  "divided", "packed", "sifted", "halved", "quartered", "cubed", "julienned",
  "plus", "more", "optional", "about", "preferably", "such", "or", "for", "to",
  "cut", "torn", "washed", "scrubbed", "stemmed", "seeded", "cored", "pitted",
  "zested", "juiced", "toasted", "roasted", "thawed", "at", "if", "cooked",
  "finely", "roughly", "coarsely", "thinly", "room", "well", "lightly",
  "crumbled", "shaved", "squeezed", "plus", "any", "ideally",
]);

export type Ingredient = { raw: string; item: string; quantity?: string };

/**
 * Splits an ingredient line into the bit you buy and the bit you measure.
 *
 * Best effort by design. When the heuristics cannot find a sensible item we
 * keep the cleaned line rather than dropping it, because a slightly noisy
 * shopping entry is far better than a silently missing one.
 */
export function parseIngredientLine(rawLine: string): Ingredient {
  const raw = decodeEntities(rawLine).replace(/\s+/g, " ").trim();

  let working = normalizeFractions(raw);

  // Budget Bytes annotates every line with its price; strip currency amounts.
  working = working.replace(/\(\s*\$[\d.,]+\s*\)/g, " ");
  // Parentheticals are metric equivalents, brand notes or "(about 4 large)".
  working = working.replace(/\([^)]*\)/g, " ");
  // Footnote markers linking to a note further down the page.
  working = working.replace(/\*+/g, " ");
  // Phrases that end the useful part of the line. Filtering these word by word
  // leaves debris — "salt and pepper to taste" became "salt and pepper to", and
  // "lemon zest plus 2 tablespoons lemon juice" became both halves run together
  // — so cut the line at the phrase instead.
  working = working.replace(
    /\s+(?:to taste|for serving|for garnish|for the pan|as needed|if needed|plus more|or more|plus\s|divided\b).*$/i,
    " ",
  );
  // Drop trailing comma clauses that describe preparation. Segments are
  // removed from the end only while they read as instructions, so a mid-phrase
  // comma ("bone-in, skin-on chicken") keeps the whole descriptor.
  const segments = working.split(",").map((segment) => segment.trim());
  while (segments.length > 1) {
    const last = segments[segments.length - 1] ?? "";
    const firstWord = last.toLowerCase().split(/\s+/)[0] ?? "";
    if (!TRAILING_CLAUSE_STARTERS.has(firstWord)) break;
    segments.pop();
  }
  working = segments.join(" ");

  const quantityMatch = new RegExp(
    String.raw`^\s*(${QUANTITY}(?:\s+${QUANTITY})?)\s*(?:(${UNITS})\b)?`,
    "i",
  ).exec(working);

  let quantity: string | undefined;
  if (quantityMatch?.[0] !== undefined && quantityMatch[0].trim().length > 0) {
    quantity = quantityMatch[0].replace(/\s+/g, " ").trim();
    working = working.slice(quantityMatch[0].length);
  } else {
    // No leading number, but "a pinch of salt" style units still lead.
    working = working.replace(new RegExp(String.raw`^\s*(?:${UNITS})\b`, "i"), " ");
  }

  // Sizes and containers stack: "3 medium stalks celery" leads with two units.
  const leadingUnit = new RegExp(String.raw`^\s*(?:${UNITS})\b`, "i");
  for (let i = 0; i < 3 && leadingUnit.test(working); i += 1) {
    working = working.replace(leadingUnit, " ");
  }

  working = working.replace(/^\s*(?:of|a|an|the)\b/i, " ");

  const words = working
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !PREP_WORDS.has(word));

  // Strip a trailing "or olive oil" alternative: the first option is enough.
  const orAt = words.indexOf("or");
  const kept = (orAt > 0 ? words.slice(0, orAt) : words).filter((w) => w !== "or");

  const item = kept.join(" ").trim();
  return {
    raw,
    item: item.length > 0 ? item : raw.toLowerCase(),
    ...(quantity !== undefined ? { quantity } : {}),
  };
}

/** Cache key for one ingredient at one store. Naive singularization is fine here. */
export function slugifyItem(item: string): string {
  const words = item
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map(singular);

  return words.join("-").slice(0, 80);
}

// ------------------------------------------------------------- the shopping list

export type ShoppingItem = { item: string; usedIn: string[]; department: string };

/** True when the user told us they always have this, so it is not worth listing. */
export function isPantryStaple(item: string, staples: readonly string[]): boolean {
  const slug = slugifyItem(item);
  return staples.some((staple) => {
    const stapleSlug = slugifyItem(staple);
    if (stapleSlug.length === 0) return false;
    return slug === stapleSlug || slug.includes(stapleSlug) || stapleSlug.includes(slug);
  });
}

/**
 * Collapses every recipe's ingredients into one list.
 *
 * This is the part the user actually wants: four recipes share an onion and a
 * head of garlic, and the useful artifact is the union with a note about what
 * each thing is for, not four separate lists to reconcile in the aisle.
 */
export function dedupeIngredients(
  recipes: readonly { name: string; ingredients: readonly Ingredient[] }[],
  departmentFor: (item: string) => string,
  staples: readonly string[] = [],
): ShoppingItem[] {
  const bySlug = new Map<string, ShoppingItem>();

  for (const recipe of recipes) {
    for (const ingredient of recipe.ingredients) {
      if (ingredient.item.length === 0) continue;
      if (isPantryStaple(ingredient.item, staples)) continue;

      const slug = slugifyItem(ingredient.item);
      if (slug.length === 0) continue;

      const existing = bySlug.get(slug);
      if (existing === undefined) {
        bySlug.set(slug, {
          item: ingredient.item,
          usedIn: [recipe.name],
          department: departmentFor(ingredient.item),
        });
      } else if (!existing.usedIn.includes(recipe.name)) {
        existing.usedIn.push(recipe.name);
      }
    }
  }

  // Merge near-duplicates. Recipes name the same product at different levels of
  // detail — "chicken broth", "low-sodium chicken broth", "cartons of
  // low-sodium chicken broth" — and four lines for one carton is exactly the
  // noise the deduped list exists to remove. When one item's words are a subset
  // of another's, the shorter name wins: it is the thing you actually buy.
  const merged = new Map<string, ShoppingItem>();
  const entries = [...bySlug.entries()].sort((a, b) => a[0].length - b[0].length);

  for (const [slug, item] of entries) {
    const words = new Set(slug.split("-").filter((word) => word.length > 0));
    let absorbed = false;

    for (const [keptSlug, kept] of merged) {
      const keptWords = keptSlug.split("-").filter((word) => word.length > 0);
      // Sorted shortest-first, so anything already kept is the shorter name.
      if (keptWords.length > 0 && keptWords.every((word) => words.has(word))) {
        for (const recipeName of item.usedIn) {
          if (!kept.usedIn.includes(recipeName)) kept.usedIn.push(recipeName);
        }
        absorbed = true;
        break;
      }
    }
    if (!absorbed) merged.set(slug, item);
  }

  // Group the printed list by department, then by how many recipes need it —
  // the shared things are the ones worth not forgetting.
  return [...merged.values()].sort(
    (a, b) =>
      a.department.localeCompare(b.department) ||
      b.usedIn.length - a.usedIn.length ||
      a.item.localeCompare(b.item),
  );
}

// ----------------------------------------------------------------- the hard rule

/**
 * Returns the allergy a recipe violates, or null when it is safe.
 *
 * Deliberately keyword-based and deliberately broad. The app tells people in
 * writing that allergies are a hard rule rather than a preference, so this
 * check has to be something we can read and reason about — not a model call
 * whose answer varies run to run.
 */
export function containsAllergen(
  ingredients: readonly Ingredient[],
  allergies: readonly string[],
): string | null {
  if (allergies.length === 0) return null;

  const haystack = ingredients
    .map((ingredient) => ` ${decodeEntities(ingredient.raw).toLowerCase()} `)
    .join(" ");

  for (const allergy of allergies) {
    if (allergy === NO_ALLERGIES) continue;

    const keywords = ALLERGEN_KEYWORDS[allergy];
    if (keywords === undefined) {
      // Something the user typed into "other". Match the words themselves.
      const typed = allergy.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
      if (typed.length >= 3 && haystack.includes(typed)) return allergy;
      continue;
    }

    for (const keyword of keywords) {
      if (haystack.includes(keyword)) return allergy;
    }
  }
  return null;
}

/** Ranks a search result before we spend a credit scraping it. */
export function scoreCandidate(
  candidate: { url: string; title: string; description?: string },
  prompt: string,
  answers: Answers,
): number {
  const haystack = `${candidate.title} ${candidate.description ?? ""}`.toLowerCase();
  let score = 0;

  for (const token of normalizeQuery(prompt).split(" ")) {
    if (token.length > 2 && haystack.includes(token)) score += 3;
  }
  for (const cuisine of answers["cuisinesLove"]?.choices ?? []) {
    if (haystack.includes(cuisine.toLowerCase())) score += 2;
  }
  for (const cuisine of answers["cuisinesAvoid"]?.choices ?? []) {
    if (haystack.includes(cuisine.toLowerCase())) score -= 4;
  }
  for (const dislike of answers["dislikes"]?.choices ?? []) {
    if (haystack.includes(dislike.toLowerCase())) score -= 3;
  }
  // Cheap signal that a URL is one recipe rather than a roundup of thirty.
  if (/\d+\s*(?:best|easy|great|amazing)\b/.test(haystack)) score -= 3;
  if (/\brecipes\b/.test(haystack)) score -= 1;

  return score;
}
