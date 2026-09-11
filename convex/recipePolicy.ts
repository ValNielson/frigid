/**
 * Every number the recipe pipeline spends against, in one place.
 *
 * The Firecrawl free tier gives 1,000 credits a month, 10 requests a minute and
 * 2 concurrent browsers. Those are not comfortable limits, so the caps here are
 * the difference between the feature working all month and it dying on day
 * three. Same spirit as policy.ts, which holds the verification throttles.
 */

/**
 * How many search results to ask for.
 *
 * Ten rather than eight because search is billed per ten results either way —
 * asking for fewer saves nothing and just narrows the pool we rank from.
 */
export const SEARCH_LIMIT = 10;

/** How many recipes a finished job aims to contain. */
export const RECIPES_PER_JOB = 4;

/**
 * How many pages we are willing to scrape to get there. The slack absorbs
 * allergen drops and pages whose ingredients will not parse.
 */
export const MAX_SCRAPES_PER_JOB = 5;

/**
 * Gap between scrapes. The free tier allows 10 requests a minute and we have
 * measured it rejecting bursts, so pace rather than retry — a rejected request
 * still costs us the wall-clock time, and retries are how budgets evaporate.
 */
export const SCRAPE_SPACING_MS = 1_500;

/**
 * Most recipes we will take from any one site.
 *
 * Without this a domain-restricted search happily returns four recipes from
 * the same blog, which is a worse answer than three from three sites even when
 * the fourth ranked higher.
 */
export const MAX_PER_DOMAIN = 2;

/** Stores we run a live product probe against. The rest get template links. */
export const MAX_STORE_PROBES = 2;

/** Items named in a single store probe query. */
export const MAX_ITEMS_PER_STORE_PROBE = 6;

/**
 * Paid extraction fallbacks per job. JSON-LD covers the allowlisted domains, so
 * hitting this cap means something has changed about a site and is worth
 * noticing rather than quietly paying for.
 */
export const MAX_LLM_CALLS_PER_JOB = 2;

/** Characters of markdown handed to the extraction fallback. */
export const LLM_MARKDOWN_WINDOW = 6_000;

/** Markdown we keep per cached page. Enough to re-run the free fallback. */
export const MAX_STORED_MARKDOWN = 40_000;

// Cache lifetimes. Recipes essentially never change; store shelves do.
export const SEARCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const RECIPE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const STORE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A store that blocked us is worth retrying sooner than one that answered. */
export const STORE_BLOCKED_TTL_MS = 24 * 60 * 60 * 1000;

// Per-user throttling.
export const MAX_PROMPT_LENGTH = 280;
export const MIN_PROMPT_LENGTH = 3;
export const MAX_JOBS_PER_USER_PER_DAY = 5;

/**
 * Ceiling on credits any one day may spend, across all users. Roughly 12% of
 * the monthly allowance, which leaves room for a bad day without leaving the
 * month unusable.
 */
export const DAILY_CREDIT_BUDGET = 120;

/** A job with no progress for this long is reported as stalled rather than running. */
export const STALL_AFTER_MS = 5 * 60 * 1000;

/** What Firecrawl bills, so the job's own tally can be checked against the account. */
export const SEARCH_CREDIT_COST = 2;
export const SCRAPE_CREDIT_COST = 1;

/**
 * Pages that are really a bot wall. Firecrawl reports these as successful
 * scrapes and bills for them, so we have to recognise the content ourselves or
 * we will cache a CAPTCHA as a recipe.
 */
export const BOT_WALL_PATTERN =
  /verify you are human|are you a robot|access denied|enable javascript to continue|checking your browser|unusual traffic|captcha/i;
