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
 * Ingredient words that indicate an allergen is present.
 *
 * Re-exported rather than defined: this used to be a second table that had
 * drifted from the recipe pipeline's copy. See convex/allergens.ts.
 */
import { ALLERGEN_TERMS } from "../allergens";
import { sharesFoodWord } from "../words";

export { ALLERGEN_TERMS };

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

/**
 * Collapses anything multi-line into one line.
 *
 * The onboarding location is free text that goes straight into a model prompt,
 * and newlines are how an injected instruction gets to look like a new turn.
 */
export function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Whether a model-returned city is safe to use.
 *
 * It is not just displayed: it becomes the key for the shared dealPlans and
 * storePlans caches and the prompt for the next call. So an answer shaped like
 * a sentence rather than a place name is rejected rather than cached, which is
 * what keeps a crafted location from steering what everyone else reads.
 */
export function isPlausibleCity(city: string): boolean {
  const trimmed = city.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return false;
  return /^\p{L}[\p{L}\p{M}\s.'-]*$/u.test(trimmed);
}

/** Two-letter state code, or nothing. */
export function normalizeState(state: string | undefined): string | undefined {
  const trimmed = state?.trim();
  return trimmed !== undefined && /^[A-Za-z]{2}$/.test(trimmed)
    ? trimmed.toUpperCase()
    : undefined;
}

/** Five-digit ZIP, or nothing. */
export function normalizeZip(zip: string | undefined): string | undefined {
  const trimmed = zip?.trim();
  return trimmed !== undefined && /^\d{5}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * The search we run against one merchant's own domain.
 *
 * Built per merchant. The planner writes several queries and run.ts used to
 * take only the first, outside the merchant loop, so every shop — a co-op, a
 * butcher, a wine store — was searched with the same generic "grocery weekly
 * ads" phrase and the planner's merchant-specific queries were never read.
 *
 * A chain's merchant row is named after its domain, so "meijer.com" is trimmed
 * back to "meijer" rather than searched with a TLD attached.
 */
export function merchantSearchQuery(
  merchantName: string,
  place: string | null,
): string {
  const raw = merchantName.trim();
  const name =
    raw.includes(".") && !raw.includes(" ") ? raw.split(".")[0] : raw;
  const where = place === null || place.trim().length === 0 ? "" : ` ${place.trim()}`;
  return `${name}${where} weekly ad specials`.replace(/\s+/g, " ").trim();
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
 *
 * Keyed on the metro as well as the domain. A chain runs different weekly ads in
 * different cities, and without the metro a Cleveland Kroger offer and a Grand
 * Rapids one with the same headline were one row that each run overwrote.
 */
export function couponDedupeKey(
  metroKey: string,
  domain: string,
  title: string,
  code?: string,
): string {
  const normalized = title.toLowerCase().replace(/\s+/g, " ").trim();
  return [metroKey, domain, normalized, (code ?? "").toLowerCase()].join("|");
}

/**
 * Puts the decimal point back into a price that lost it.
 *
 * Weekly-ad pages render cents as superscript, and extraction flattens
 * "$1.<sup>49</sup>" to "$149". A live run stored barbecue sauce at $149 and
 * chicken at $399. No food costs over a hundred dollars, so a bare dollar
 * amount that large is a missing decimal rather than a real price.
 *
 * Leaves anything already carrying a decimal alone, and anything under the
 * threshold — "2/$5" and "$25" are both fine as written.
 */
export function repairPrices(text: string): string {
  return text.replace(
    /\$\s?(\d[\d,]*)(\.\d{1,2})?/g,
    (whole, digits: string, decimals: string | undefined) => {
      if (decimals !== undefined) return whole;
      const amount = Number(digits.replace(/,/g, ""));
      if (!Number.isFinite(amount) || amount < 100) return whole;
      return `$${(amount / 100).toFixed(2)}`;
    },
  );
}

/**
 * Whether a price is one we still do not believe after repairing it.
 *
 * recipeEmail's own rule is that it never prints a price it cannot stand
 * behind, so a figure this far out is dropped rather than shown.
 */
export function hasImplausiblePrice(text: string): boolean {
  for (const match of repairPrices(text).matchAll(/\$\s?(\d[\d,]*)(\.\d{1,2})?/g)) {
    const amount = Number(`${match[1].replace(/,/g, "")}${match[2] ?? ""}`);
    if (Number.isFinite(amount) && amount > 100) return true;
  }
  return false;
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

/* ---------------------------------------------------------------------------
 * Inbound mail: scaffolding, not a working path.
 *
 * The next three helpers and MAX_EMAIL_CHARS are the cost argument for mining
 * coupons out of a user's own mail. They are tested and they have no callers:
 * the webhook records events into agentmailEvents and nothing reads that table
 * yet. Extraction is deliberately unwritten until this is on a cloud deployment
 * with a registered webhook and real messages to build against.
 *
 * Kept rather than cut so the prefilter is not reinvented, and labelled so the
 * passing tests are not mistaken for a shipped feature.
 * ------------------------------------------------------------------------- */

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
  T extends {
    title: string;
    details?: string;
    itemTerms: readonly string[];
    primaryItem?: string;
  },
>(coupons: readonly T[], ingredients: readonly string[]): T[] {
  const wanted = ingredients
    .map((item) => item.trim())
    .filter((item) => item.length > 2);
  if (wanted.length === 0) return [];

  return coupons.filter((coupon) => {
    const subject = coupon.primaryItem?.trim();

    // What the offer is actually for, when the extractor told us. Matching on
    // everything an offer mentions is how "cheddar" on a shopping list came back
    // as a box of Goldfish crackers: the word is genuinely in the product name,
    // but the thing on sale is a cracker.
    if (subject !== undefined && subject.length > 0) {
      return wanted.some((item) => sharesFoodWord(item, subject));
    }

    // Rows written before primaryItem existed. Whole terms rather than a
    // substring sweep of the title, which is the looser half of the old rule.
    return wanted.some((item) =>
      coupon.itemTerms.some((term) => sharesFoodWord(item, term)),
    );
  });
}

/**
 * Where an offer belongs in a store.
 *
 * Replaces a boolean. Asking a model "is this food?" is the weakest form the
 * question can take: false has to be actively chosen against a default of
 * omission, and a live run stored BBQ tools, a crockpot and fifty pounds of dog
 * food because an omitted flag read as yes. An enum with somewhere correct to
 * put a crockpot makes the right answer the easy one.
 *
 * Kept as a shared list because the extraction schema and the filter must agree
 * on the spelling, and because the shopping list groups by department already.
 */
export const COUPON_DEPARTMENTS: readonly string[] = [
  "produce",
  "meat",
  "dairy",
  "bakery",
  "pantry",
  "frozen",
  "beverage",
  "snack",
  "household",
  "pet",
  "apparel",
  "other",
];

/** The ones a cook can eat. */
const FOOD_DEPARTMENTS: ReadonlySet<string> = new Set([
  "produce",
  "meat",
  "dairy",
  "bakery",
  "pantry",
  "frozen",
  "beverage",
  "snack",
]);

/**
 * The backstop, now categories rather than products.
 *
 * Was sixty-nine hand-written product names, which is the wrong shape: "not
 * food" is unbounded, so the list could only grow after something had already
 * reached a user. These are the handful of category words that catch a
 * misfiled row regardless of what the product is called — a dog treat and a dog
 * bed are both "dog".
 */
const NON_FOOD_TERMS: readonly string[] = [
  "dog", "cat", "puppy", "kitten", "pet ", "litter",
  "cookware", "bakeware", "utensil", "cutlery", "dinnerware",
  "detergent", "cleaner", "bleach", "disinfectant",
  "apparel", "clothing", "footwear",
  "battery", "batteries", "gift card",
];

/**
 * Whether an extracted row is food we should store.
 *
 * Three signals, and the order is the point. A department we know is not food
 * settles it outright. A category word settles it too, because the extractor
 * misfiling something is exactly what this is here for. Anything the extractor
 * could not place — "other", or a row with no department at all — has to earn
 * its way in by naming something the food vocabulary recognises.
 *
 * That last clause is what the learned vocabulary is for: gnocchi, samosa and
 * watermelon are all absent from the static keyword lists, so without recipes
 * teaching it, an honest "other" would be thrown away.
 */
export function keepAsFood(
  coupon: {
    title: string;
    details?: string;
    department?: string;
    primaryItem?: string;
  },
  isKnownFood: (text: string) => boolean = () => false,
): boolean {
  const department = coupon.department?.trim().toLowerCase();
  const haystack = `${coupon.title} ${coupon.details ?? ""}`.toLowerCase();

  if (NON_FOOD_TERMS.some((term) => haystack.includes(term))) return false;

  if (department !== undefined && FOOD_DEPARTMENTS.has(department)) return true;
  if (department !== undefined && department !== "other") return false;

  // Unplaced. The vocabulary is the second opinion.
  return isKnownFood(`${coupon.primaryItem ?? ""} ${coupon.title}`);
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
 * Read bound on the coupon pool. The table grows with every scrape and has no
 * natural ceiling, so the query that feeds one run takes a slice rather than
 * the table — newest first, which is the part that was wrong. Set well above
 * what a single digest can use, so hitting it means something upstream is wrong.
 */
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

/**
 * Minimum gap between manual runs for one person. Enforced server-side, since
 * a run costs real Firecrawl and model spend and a disabled button is only a
 * suggestion.
 */
export const MANUAL_RUN_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Deal plans go stale the way anything scraped from the world does: a co-op
 * closes, a domain lapses, a search phrasing stops working. Thirty days keeps
 * the cost negligible while bounding how wrong a cached plan can get.
 */
export const PLAN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Store plans consulted in one run, and merchants resolved per store plan. */
export const MAX_STORE_PLANS_PER_RUN = 3;
export const MAX_MERCHANTS_PER_STORE_PLAN = 3;

/**
 * Local merchants a city plan will look up.
 *
 * Was unbounded, and a live San Diego run spent nine site lookups resolving
 * store names — the entire per-minute request budget — before the merchant loop
 * asked for anything. Discovery is the cheap half; it must not starve the half
 * that actually returns coupons.
 */
export const MAX_CITY_MERCHANTS = 3;

/**
 * How long a merchant waits before trying again after the limiter turned it
 * away, and how many times. Long enough for the rolling window to drain rather
 * than for the request to be retried into the same wall.
 */
export const RATE_LIMIT_BACKOFF_MS = 30_000;
export const MAX_MERCHANT_ATTEMPTS = 3;

/** Whether a cached plan is still worth reusing. */
export function isPlanFresh(createdAt: number, now: number): boolean {
  return now - createdAt < PLAN_TTL_MS;
}

/**
 * The cache key for one write-in store. Normalized so "Bombay Grocers" and
 * "bombay  grocers" are one entry rather than two plans for one shop.
 */
export function storePlanKey(store: string): string {
  return store.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Whether a scraped page belongs to the user's metro.
 *
 * Exists because a model naming local businesses will sometimes hand back the
 * right brand in the wrong city — a Lansing store page serves current,
 * well-formed specials that would otherwise be ingested as this user's prices,
 * and nothing downstream would look wrong. Like the allergen rule, it discards
 * rather than risk being confidently wrong.
 *
 * Only applied to merchants a model or a search proposed. A national chain's ad
 * page often names no city at all, and its domain is already the guarantee.
 */
export function matchesMetro(
  pageText: string,
  place: { city: string; state?: string; zip?: string },
): boolean {
  const haystack = pageText.toLowerCase();

  if (haystack.includes(place.city.trim().toLowerCase())) return true;

  // Same first three digits covers a metro's ZIPs without reaching the next
  // one over, which a two-digit prefix would.
  const prefix = place.zip?.trim().slice(0, 3);
  if (prefix !== undefined && prefix.length === 3) {
    if (new RegExp(`\\b${prefix}\\d{2}\\b`).test(haystack)) return true;
  }

  return false;
}

/**
 * Sites that describe merchants rather than being one.
 *
 * A name search for a small shop often surfaces its Yelp or Facebook listing
 * above its own site, and storing that as a merchant means scraping a directory
 * for deals it does not set. Matched by suffix, so mobile and regional
 * subdomains are covered too.
 */
const DIRECTORY_DOMAINS: readonly string[] = [
  "yelp.com",
  "facebook.com",
  "instagram.com",
  "tripadvisor.com",
  "mapquest.com",
  "yellowpages.com",
  "foursquare.com",
  "doordash.com",
  "ubereats.com",
  "grubhub.com",
  "opentable.com",
  "google.com",
  "apple.com",
  "wikipedia.org",
  "reddit.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "youtube.com",
  "amazon.com",
  "indeed.com",
  "glassdoor.com",
  // News and listings sites write *about* where to shop. A live San Diego run
  // resolved the Union-Tribune as a grocery merchant and would have scraped a
  // newspaper for weekly-ad prices.
  "sandiegouniontribune.com",
  "patch.com",
  "eater.com",
  "timeout.com",
  "thrillist.com",
  "groupon.com",
  "retailmenot.com",
  "coupons.com",
];

/** Suffixes that give a news or blog site away without naming each one. */
const DIRECTORY_SUFFIXES: readonly string[] = [
  ".news",
  "news.com",
  "times.com",
  "tribune.com",
  "herald.com",
  "gazette.com",
  "journal.com",
  "magazine.com",
];

/** Whether a resolved domain is a directory listing rather than a merchant. */
export function isDirectorySite(domain: string): boolean {
  const host = domain.trim().toLowerCase();
  if (DIRECTORY_DOMAINS.some((known) => host === known || host.endsWith(`.${known}`))) {
    return true;
  }
  return DIRECTORY_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Firecrawl results fetched per merchant.
 *
 * Measured, not assumed: one searchDeals call at limit 2 costs 12 credits of a
 * 1,000/month allowance, because the json format runs server-side extraction on
 * every result. Each extra result is roughly five more credits, so this is the
 * dial that decides whether a run costs 60 credits or 35.
 */
export const SEARCH_RESULTS_PER_MERCHANT = 2;

/** Measured cost of one searchDeals call at the limit above. */
export const SEARCH_DEALS_CREDIT_COST = 12;

/**
 * Cost of one findSite lookup. A plain search with no extraction, so it bills
 * far below a coupon scrape — but it is not free and the ledger should say so.
 */
export const FIND_SITE_CREDIT_COST = 2;
