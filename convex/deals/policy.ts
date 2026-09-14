/**
 * Shared, runtime-agnostic policy for coupon discovery. Imported by both the
 * default-runtime mutations in data.ts and the "use node" actions that call
 * Firecrawl, OpenAI, and AgentMail, so it must stay free of Node and Convex
 * imports — the same rule policy.ts follows.
 *
 * Everything expensive in this feature is a decision made here: which merchants
 * are worth a Firecrawl call, which emails are worth a model call, and which
 * coupons a user must never see.
 */

/** Merchants scraped in one run. Bounds Firecrawl spend per prompt. */
export const MAX_MERCHANTS_PER_RUN = 5;

/** A weekly ad changes weekly, so re-fetching inside a day buys nothing. */
export const SCRAPE_TTL_MS = 24 * 60 * 60 * 1000;

/** Passed to Firecrawl so it may serve a recent crawl instead of refetching. */
export const FIRECRAWL_MAX_AGE_MS = SCRAPE_TTL_MS;

/**
 * Hard cap on email text handed to the model. Marketing HTML routinely runs to
 * tens of thousands of characters of table markup wrapping four lines of offer,
 * and paying to tokenize that is the easiest way to lose control of the bill.
 */
export const MAX_EMAIL_CHARS = 4000;

/**
 * The grocery chains offered by name in onboarding, mapped to their domain.
 *
 * Deliberately domains and not deal-page URLs: a chain's weekly-ad path moves,
 * and a wrong constant costs a Firecrawl call that 404s while looking like a
 * merchant with no deals. The planner scopes a Firecrawl search to the domain
 * instead, which finds the live page and costs no model tokens either way.
 *
 * Keys must match the `stores` options in onboardingQuestions.ts exactly.
 */
export const STORE_DOMAINS: Readonly<Record<string, string>> = {
  Aldi: "aldi.us",
  Costco: "costco.com",
  Kroger: "kroger.com",
  Meijer: "meijer.com",
  "Trader Joe's": "traderjoes.com",
  "Whole Foods": "wholefoodsmarket.com",
  Walmart: "walmart.com",
  Target: "target.com",
  Publix: "publix.com",
  "Safeway or Albertsons": "safeway.com",
  "H-E-B": "heb.com",
  Wegmans: "wegmans.com",
};

/**
 * The two `stores` options that name a category rather than a business. These
 * are the only entries that need the planner, and the reason it still earns a
 * call: naming the actual co-ops and international markets in a given city is
 * knowledge a lookup table cannot hold.
 */
export const VAGUE_STORES: readonly string[] = [
  "Local co-op or farmers market",
  "Asian or international market",
];

/**
 * Ingredient words that indicate an allergen is present.
 *
 * Keys match the `allergies` options in onboardingQuestions.ts. Matching is
 * substring-based and deliberately over-broad: "butternut squash" trips the
 * dairy rule through "butter", and that is the correct direction to be wrong
 * in. A missed allergen is a health incident; a suppressed coupon is a coupon.
 */
export const ALLERGEN_TERMS: Readonly<Record<string, readonly string[]>> = {
  Peanuts: ["peanut", "groundnut", "arachis", "satay"],
  "Tree nuts": [
    "almond",
    "cashew",
    "walnut",
    "pecan",
    "pistachio",
    "hazelnut",
    "filbert",
    "macadamia",
    "brazil nut",
    "pine nut",
    "praline",
    "marzipan",
    "nougat",
    "nutella",
  ],
  "Milk or dairy": [
    "milk",
    "dairy",
    "cheese",
    "butter",
    "cream",
    "yogurt",
    "yoghurt",
    "ghee",
    "whey",
    "casein",
    "custard",
    "gelato",
    "mozzarella",
    "cheddar",
    "parmesan",
    "ricotta",
    "brie",
  ],
  Eggs: [
    "egg",
    "mayonnaise",
    "mayo",
    "aioli",
    "meringue",
    "albumin",
    "frittata",
    "omelet",
    "omelette",
    "custard",
  ],
  "Wheat or gluten": [
    "wheat",
    "gluten",
    "flour",
    "bread",
    "pasta",
    "noodle",
    "cracker",
    "cereal",
    "barley",
    "rye",
    "semolina",
    "couscous",
    "farro",
    "seitan",
    "panko",
    "tortilla",
    "bagel",
    "croissant",
    "pastry",
    "cake",
    "cookie",
    "pizza",
    "pretzel",
    "biscuit",
  ],
  Soy: [
    "soy",
    "soya",
    "tofu",
    "edamame",
    "miso",
    "tempeh",
    "tamari",
    "teriyaki",
  ],
  Fish: [
    "fish",
    "salmon",
    "tuna",
    "cod",
    "halibut",
    "tilapia",
    "anchovy",
    "anchovies",
    "sardine",
    "trout",
    "snapper",
    "mackerel",
    "herring",
    "worcestershire",
    "caesar",
  ],
  Shellfish: [
    "shrimp",
    "prawn",
    "crab",
    "lobster",
    "clam",
    "mussel",
    "oyster",
    "scallop",
    "crawfish",
    "crayfish",
    "squid",
    "calamari",
    "octopus",
    "shellfish",
  ],
  Sesame: ["sesame", "tahini", "hummus", "halva", "za'atar", "benne"],
  Mustard: ["mustard", "dijon"],
  Celery: ["celery", "celeriac"],
  Sulfites: ["sulfite", "sulphite", "wine"],
};

/** Subject-line shapes that make an email worth a model call. */
const PROMO_SUBJECT_TERMS: readonly string[] = [
  "deal",
  "coupon",
  "sale",
  "save",
  "savings",
  "% off",
  "percent off",
  "offer",
  "weekly ad",
  "special",
  "discount",
  "clearance",
  "bogo",
  "buy one",
  "promo",
  "price drop",
  "rewards",
  "digital coupon",
];

/** Strips scheme, www, path, and case so a domain can be an identity. */
export function normalizeDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const withoutScheme = trimmed.replace(/^[a-z]+:\/\//, "");
  const host = withoutScheme.split(/[/?#]/)[0].replace(/^www\./, "");
  if (host.length === 0 || !host.includes(".")) return null;
  return host;
}

/** The cache key for a normalized place. */
export function locationKey(city: string, state?: string): string {
  const parts = [city.trim().toLowerCase()];
  if (state !== undefined && state.trim().length > 0) {
    parts.push(state.trim().toLowerCase());
  }
  return parts.join(", ");
}

/** The key a raw onboarding location answer is cached under. */
export function rawLocationKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Identity of an offer. Upserts go through this so re-scraping an unchanged ad
 * updates rows instead of accumulating them.
 */
export function couponDedupeKey(
  domain: string,
  title: string,
  code?: string,
): string {
  const normalized = title.toLowerCase().replace(/\s+/g, " ").trim();
  return [domain, normalized, (code ?? "").toLowerCase()].join("|");
}

/**
 * Everything a coupon says, lowercased, as one haystack. Allergen and
 * ingredient matching both read this rather than picking over fields.
 */
function couponHaystack(coupon: {
  title: string;
  details?: string;
  itemTerms: readonly string[];
}): string {
  return [coupon.title, coupon.details ?? "", ...coupon.itemTerms]
    .join(" ")
    .toLowerCase();
}

/**
 * Whether a coupon must be withheld from someone with these allergies.
 *
 * Runs before the model sees anything and is never delegated to it. A model
 * asked to "avoid allergens" will comply almost always, and almost always is
 * the wrong standard for the one rule onboarding calls hard.
 *
 * Unrecognized allergies — anything typed into the question's free-text box —
 * are matched as literal substrings, so a declared allergen we have no term
 * list for still filters on its own name.
 */
export function violatesAllergies(
  coupon: { title: string; details?: string; itemTerms: readonly string[] },
  allergies: readonly string[],
): boolean {
  const haystack = couponHaystack(coupon);

  for (const allergy of allergies) {
    const terms = ALLERGEN_TERMS[allergy];
    if (terms === undefined) {
      const literal = allergy.trim().toLowerCase();
      if (literal.length > 2 && haystack.includes(literal)) return true;
      continue;
    }
    for (const term of terms) {
      if (haystack.includes(term)) return true;
    }
  }

  return false;
}

/** Coupons the user is allowed to see, in declaration order. */
export function excludeAllergens<
  T extends { title: string; details?: string; itemTerms: readonly string[] },
>(coupons: readonly T[], allergies: readonly string[]): T[] {
  if (allergies.length === 0) return [...coupons];
  return coupons.filter((coupon) => !violatesAllergies(coupon, allergies));
}

/**
 * The free prefilter. An email earns a model call only if a known merchant sent
 * it or the subject reads promotional, so an inbox full of ordinary mail costs
 * nothing to ignore.
 */
export function isLikelyPromotional(
  message: { from: string; subject?: string },
  knownDomains: ReadonlySet<string>,
): boolean {
  const sender = message.from.toLowerCase();
  for (const domain of knownDomains) {
    if (sender.includes(domain)) return true;
  }

  const subject = (message.subject ?? "").toLowerCase();
  return PROMO_SUBJECT_TERMS.some((term) => subject.includes(term));
}

/**
 * Reduces marketing HTML to the words in it.
 *
 * AgentMail's docs note that `text` and `preview` are absent for HTML-only
 * mail, which describes most of what merchants send, so this runs on
 * `extracted_html` rather than being a fallback nobody hits.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The model's share of an email: stripped, collapsed, and capped. */
export function emailTextForModel(message: {
  text?: string;
  extractedText?: string;
  extractedHtml?: string;
  html?: string;
}): string {
  const source =
    message.extractedText ??
    message.text ??
    stripHtml(message.extractedHtml ?? message.html ?? "");
  return source.replace(/\s+/g, " ").trim().slice(0, MAX_EMAIL_CHARS);
}

/**
 * Coupons that mention any of these ingredients.
 *
 * This is what the recipe branch calls, and why itemTerms is stored lowercased:
 * answering "is anything in this recipe on sale" has to be free, because it
 * runs once per recipe rather than once per run.
 */
export function matchIngredients<
  T extends { title: string; details?: string; itemTerms: readonly string[] },
>(coupons: readonly T[], ingredients: readonly string[]): T[] {
  const wanted = ingredients
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 2);
  if (wanted.length === 0) return [];

  return coupons.filter((coupon) => {
    const haystack = couponHaystack(coupon);
    return wanted.some((item) => haystack.includes(item));
  });
}

/** Whether a stored scrape is still fresh enough to reuse. */
export function isScrapeFresh(lastScrapedAt: number | undefined, now: number) {
  if (lastScrapedAt === undefined) return false;
  return now - lastScrapedAt < SCRAPE_TTL_MS;
}

/** The explicit opt-out on the emailFrequency question. */
export const ON_DEMAND_ONLY = "Only when I ask";

/**
 * How long to wait between digests, per emailFrequency option.
 *
 * Keys match onboardingQuestions.ts. ON_DEMAND_ONLY is absent rather than set
 * to Infinity: it is not a long interval, it is a request not to be mailed, and
 * the cron skips it entirely.
 */
const DIGEST_INTERVAL_MS: Readonly<Record<string, number>> = {
  "Every day": 24 * 60 * 60 * 1000,
  // Roughly three a week, which is what "a few" tends to mean here.
  "A few times a week": 2 * 24 * 60 * 60 * 1000,
  "Once a week": 7 * 24 * 60 * 60 * 1000,
  "Every other week": 14 * 24 * 60 * 60 * 1000,
  "Once a month": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Whether the daily cron should mail this user now.
 *
 * One cron covers all six options by asking this per user, rather than a
 * separate scheduled job per cadence. An unset or unrecognized frequency means
 * no, so a new option added to onboarding cannot start mailing people by
 * accident before anyone decides how often it should.
 */
export function isDigestDue(
  emailFrequency: string | undefined,
  lastDigestAt: number | undefined,
  now: number,
): boolean {
  if (emailFrequency === undefined) return false;
  if (emailFrequency === ON_DEMAND_ONLY) return false;

  const interval = DIGEST_INTERVAL_MS[emailFrequency];
  if (interval === undefined) return false;
  if (lastDigestAt === undefined) return true;

  return now - lastDigestAt >= interval;
}

/**
 * The frequency values the cron is allowed to mail, derived from the interval
 * table so the two cannot drift. ON_DEMAND_ONLY is absent by construction,
 * which is what lets the digest query hit by_email_frequency once per cadence
 * instead of scanning every user.
 */
export const MAILABLE_FREQUENCIES: readonly string[] =
  Object.keys(DIGEST_INTERVAL_MS);

/**
 * Read bounds. Both tables grow without a natural ceiling — merchants with
 * every new city, coupons with every scrape — so the queries that feed one run
 * take a slice rather than the table. Set well above what a single digest can
 * use, so hitting either means something upstream is wrong.
 */
export const MAX_MERCHANTS_READ = 500;
export const MAX_COUPON_POOL = 500;

/**
 * Splits the onboarding `stores` answer into domains we already know and the
 * entries that need the planner.
 *
 * The named chains resolve through STORE_DOMAINS, so the common case — someone
 * who checked Kroger, Meijer, and Aldi — reaches Firecrawl with no model call
 * at all. Only the two category options and free-text write-ins need one.
 */
export function splitStores(stores: readonly string[]): {
  domains: string[];
  vague: string[];
} {
  const domains: string[] = [];
  const vague: string[] = [];

  for (const store of stores) {
    const known = STORE_DOMAINS[store];
    if (known !== undefined) {
      domains.push(known);
      continue;
    }
    if (store.trim().length > 0) vague.push(store.trim());
  }

  return { domains, vague };
}
