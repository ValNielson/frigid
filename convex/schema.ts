import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  agentmailEvents: defineTable({
    eventId: v.string(),
    eventType: v.string(),
    payload: v.any(),
  })
    .index("by_event_id", ["eventId"])
    .index("by_event_type", ["eventType"]),

  users: defineTable({
    // Normalized: trimmed and lowercased. Unique by convention, enforced by
    // always looking up through by_email before inserting.
    email: v.string(),
    verifiedAt: v.optional(v.number()),
    // Only ever written by a mutation that has already resolved a session, and
    // sessions are only minted by a successful verification. That is what makes
    // "onboarded but not verified" unrepresentable.
    onboardedAt: v.optional(v.number()),
    // Denormalized off the preferences row so the digest cron can pick its
    // recipients from an index instead of reading every preferences document.
    emailFrequency: v.optional(v.string()),
    subscribed: v.boolean(),
    unsubscribedAt: v.optional(v.number()),
    // Opaque, unguessable, and stable for the life of the row.
    unsubscribeToken: v.string(),
    // sha256(code + pepper) as hex. Cleared once the code is consumed.
    codeHash: v.optional(v.string()),
    codeExpiresAt: v.optional(v.number()),
    attemptsRemaining: v.number(),
    // Resend throttling.
    lastSentAt: v.optional(v.number()),
    sendsInWindow: v.number(),
    windowStartedAt: v.number(),
    // Submission throttling, which is a different question from resending and
    // so carries its own window. Optional because rows written before it
    // existed have no value; consumeCode treats absent as zero.
    verifyAttemptsInWindow: v.optional(v.number()),
    verifyWindowStartedAt: v.optional(v.number()),
    // When the deals digest last went out, so the daily cron can tell who is
    // due without reading a second table.
    lastDigestAt: v.optional(v.number()),
    // When the cron last *tried*. Separate from lastDigestAt because a run that
    // matched nothing sends no mail, and keying the cadence on sends alone left
    // those users due forever and re-run every day.
    lastDigestAttemptAt: v.optional(v.number()),
  })
    .index("by_email", ["email"])
    .index("by_unsubscribe_token", ["unsubscribeToken"])
    .index("by_email_frequency", ["emailFrequency"]),

  // One row per active sign-in. The raw token never lands in the database; only
  // sha256(token + pepper) does, so a database leak does not hand out sessions.
  sessions: defineTable({
    userId: v.id("users"),
    tokenHash: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
    // Set at creation and not since: resolving a session happens in a query,
    // which cannot write. Left in place rather than dropped because removing a
    // field fails the schema push while rows still carry it.
    lastSeenAt: v.number(),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_user", ["userId"])
    .index("by_expires_at", ["expiresAt"]),

  // Onboarding answers plus the two derived artifacts we do not want to
  // recompute: the human-readable report and the compact line that gets injected
  // into recipe prompts later.
  preferences: defineTable({
    userId: v.id("users"),
    schemaVersion: v.number(),
    // questionId -> answer. A record rather than one column per question, so
    // adding a question is an edit to onboardingQuestions.ts with no migration.
    answers: v.record(
      v.string(),
      v.object({
        choices: v.array(v.string()),
        other: v.optional(v.string()),
      }),
    ),
    summaryText: v.string(),
    promptContext: v.string(),
    completedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  // ---- Deals ---------------------------------------------------------------

  // Somewhere that sells food and publishes offers. Rows are shared across
  // users: two people who both shop at Meijer point at the same merchant.
  merchants: defineTable({
    name: v.string(),
    // Normalized bare hostname, no scheme or www. The identity of the row.
    domain: v.string(),
    dealsUrl: v.optional(v.string()),
    signupUrl: v.optional(v.string()),
    // Only set for merchants tied to one place, which is why the national
    // chains in STORE_DOMAINS leave it empty.
    city: v.optional(v.string()),
    kind: v.string(),
    // "static" for the built-in chain map, "codex" when the planner named it,
    // "search" when Firecrawl turned it up. Kept so a bad source is traceable.
    source: v.string(),
    lastScrapedAt: v.optional(v.number()),
    discoveredAt: v.number(),
  })
    .index("by_domain", ["domain"])
    .index("by_city", ["city"]),

  // A single offer. userId is null for anything scraped from a public page,
  // which is most of them: one scrape of a weekly ad serves every user who
  // shops there. Only coupons mined from a user's own mail are private.
  coupons: defineTable({
    userId: v.union(v.id("users"), v.null()),
    merchantId: v.id("merchants"),
    title: v.string(),
    details: v.optional(v.string()),
    code: v.optional(v.string()),
    discount: v.optional(v.string()),
    // Lowercased ingredient words, so a recipe's ingredient list can be matched
    // against stored coupons without a model call.
    itemTerms: v.array(v.string()),
    tags: v.array(v.string()),
    expiresAt: v.optional(v.number()),
    // What the offer is actually for, as one food word. Matching reads this
    // rather than everything the title mentions, because "Goldfish Cheddar
    // Crackers" mentions cheddar and is a cracker. Optional: rows written before
    // the field existed fall back to itemTerms.
    primaryItem: v.optional(v.string()),
    // The metro this offer was scraped for. A chain runs different weekly ads in
    // different cities, and without this a Grand Rapids price was served to a
    // Cleveland shopper. Optional for the same backward-compatibility reason.
    metroKey: v.optional(v.string()),
    sourceKind: v.string(),
    sourceUrl: v.optional(v.string()),
    messageId: v.optional(v.string()),
    // Stable hash of merchant + title + code. Upserts go through this, so
    // re-scraping the same ad does not pile up duplicates.
    dedupeKey: v.string(),
    foundAt: v.number(),
  })
    .index("by_dedupe_key", ["dedupeKey"])
    .index("by_user", ["userId"])
    .index("by_merchant", ["merchantId"])
    .index("by_expires_at", ["expiresAt"]),

  // When a merchant was last scraped *for a given metro*.
  //
  // Freshness cannot live on the merchant row: identity there is the domain
  // alone, so scraping Kroger for Grand Rapids marked it fresh everywhere and a
  // Cleveland run would skip it inside the TTL and store nothing.
  merchantScrapes: defineTable({
    merchantId: v.id("merchants"),
    metroKey: v.string(),
    lastScrapedAt: v.number(),
  }).index("by_merchant_metro", ["merchantId", "metroKey"]),

  // Cache for normalizing the free-text onboarding location. "Grand Rapids, MI",
  // "grand rapids", and "49503" are three spellings of one place, and without
  // this they would be three separate deal plans.
  locations: defineTable({
    // The user's raw answer, lowercased and trimmed. The cache key.
    raw: v.string(),
    city: v.string(),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
    normalizedAt: v.number(),
  }).index("by_raw", ["raw"]),

  // What to ask Firecrawl for in a given place. Keyed on normalized location
  // alone: where to look in a city is the same question for every diet, and
  // personalization happens when matching, which costs nothing.
  dealPlans: defineTable({
    locationKey: v.string(),
    queries: v.array(v.string()),
    targetUrls: v.array(v.string()),
    createdAt: v.number(),
  }).index("by_location_key", ["locationKey"]),

  // What one write-in store resolves to in one city. Separate from dealPlans so
  // the shared city plan stays shared: keying either on the combination would
  // mean a fresh plan per distinct set of write-ins, which is most of what the
  // cache was for.
  storePlans: defineTable({
    locationKey: v.string(),
    // Normalized, so casing cannot fork one shop into two cached plans.
    storeKey: v.string(),
    domains: v.array(v.string()),
    createdAt: v.number(),
  }).index("by_location_store", ["locationKey", "storeKey"]),

  // One row per pipeline execution. Exists so a run that silently found nothing
  // is distinguishable from one that never started, and so the merchant cap is
  // visible rather than looking like full coverage.
  runs: defineTable({
    userId: v.id("users"),
    kind: v.string(),
    status: v.string(),
    trigger: v.string(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    counts: v.object({
      merchants: v.number(),
      scraped: v.number(),
      couponsFound: v.number(),
      couponsMatched: v.number(),
      // Coupons discarded because a proposed merchant's page could not prove
      // it serves this metro. Counted rather than silently dropped. Optional
      // because rows written before the check existed genuinely have no value
      // for it; every new run sets it.
      offMetroDropped: v.optional(v.number()),
      // Merchants skipped because their last scrape is still inside the TTL.
      // The saving is the point: each skip is a Firecrawl call not made.
      merchantsFresh: v.optional(v.number()),
    }),
    skippedMerchants: v.optional(v.array(v.string())),
    error: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_kind_started", ["kind", "startedAt"]),

  // One row per "find me recipes" request. Everything the screen and the email
  // need lives here, so the UI is a single reactive read and the job's own
  // credit tally can be checked against the Firecrawl account.
  recipeJobs: defineTable({
    userId: v.id("users"),
    prompt: v.string(),
    // The deterministic query we actually sent, kept so a surprising result set
    // can be explained without re-running the job.
    searchQuery: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("searching"),
      v.literal("reading"),
      v.literal("shopping"),
      // Looking for coupons covering this job's shopping list. Its own status
      // because a cold city has to be scraped first, which is slow enough that
      // "shopping" would look stuck.
      v.literal("dealing"),
      v.literal("emailing"),
      v.literal("done"),
      v.literal("failed"),
    ),
    statusDetail: v.optional(v.string()),
    candidates: v.array(
      v.object({
        url: v.string(),
        title: v.string(),
        description: v.optional(v.string()),
      }),
    ),
    recipes: v.array(
      v.object({
        url: v.string(),
        name: v.string(),
        image: v.optional(v.string()),
        totalTimeMinutes: v.optional(v.number()),
        servings: v.optional(v.string()),
        source: v.union(
          v.literal("jsonld"),
          v.literal("markdown"),
          v.literal("llm"),
        ),
        ingredients: v.array(
          v.object({
            raw: v.string(),
            item: v.string(),
            quantity: v.optional(v.string()),
          }),
        ),
      }),
    ),
    shopping: v.array(
      v.object({
        item: v.string(),
        usedIn: v.array(v.string()),
        department: v.string(),
        stores: v.array(
          v.object({
            storeSlug: v.string(),
            storeLabel: v.string(),
            searchUrl: v.optional(v.string()),
            productTitle: v.optional(v.string()),
            productUrl: v.optional(v.string()),
          }),
        ),
      }),
    ),
    // Recipes we found but did not send, with the reason. An allergen drop is
    // something the user deserves to be told about rather than a silent gap.
    skipped: v.array(v.object({ url: v.string(), reason: v.string() })),
    // Coupons covering this job's own shopping list. Optional because rows
    // written before the deals step existed genuinely have none, and a required
    // field would fail the schema push against them.
    deals: v.optional(
      v.array(
        v.object({
          title: v.string(),
          discount: v.optional(v.string()),
          details: v.optional(v.string()),
          code: v.optional(v.string()),
          sourceUrl: v.optional(v.string()),
          merchantName: v.optional(v.string()),
        }),
      ),
    ),
    creditsUsed: v.number(),
    llmCallsUsed: v.number(),
    error: v.optional(v.string()),
    createdAt: v.number(),
    // Touched at every step. A job with no movement for a while is reported as
    // stalled, which is how a crashed action surfaces without a watchdog cron.
    updatedAt: v.number(),
    finishedAt: v.optional(v.number()),
    emailedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_status", ["userId", "status"])
    .index("by_created", ["createdAt"]),

  // The next four tables are all caches over paid Firecrawl calls. Keys are
  // readable normalized strings rather than hashes: none of this is secret, and
  // being able to eyeball a key in the dashboard is worth more than the bytes.
  // Every read checks expiresAt, so a stale row is simply overwritten in place
  // and the tables stay bounded without a sweep job.

  searchCache: defineTable({
    queryKey: v.string(),
    results: v.array(
      v.object({
        url: v.string(),
        title: v.string(),
        description: v.optional(v.string()),
      }),
    ),
    fetchedAt: v.number(),
    expiresAt: v.number(),
  }).index("by_query_key", ["queryKey"]),

  // Markdown only. The rawHtml we parse JSON-LD out of routinely runs past a
  // megabyte, and once parsed we never need it again.
  firecrawlPages: defineTable({
    urlKey: v.string(),
    url: v.string(),
    markdown: v.string(),
    title: v.optional(v.string()),
    hadJsonLd: v.boolean(),
    fetchedAt: v.number(),
    expiresAt: v.number(),
  }).index("by_url_key", ["urlKey"]),

  // Keyed by URL, not by user, so one person's search warms everyone's.
  recipeCache: defineTable({
    urlKey: v.string(),
    url: v.string(),
    domain: v.string(),
    name: v.string(),
    image: v.optional(v.string()),
    totalTimeMinutes: v.optional(v.number()),
    servings: v.optional(v.string()),
    source: v.union(
      v.literal("jsonld"),
      v.literal("markdown"),
      v.literal("llm"),
    ),
    ingredients: v.array(
      v.object({
        raw: v.string(),
        item: v.string(),
        quantity: v.optional(v.string()),
      }),
    ),
    fetchedAt: v.number(),
    expiresAt: v.number(),
  }).index("by_url_key", ["urlKey"]),

  // "none" and "blocked" are cached too. Learning that a store has nothing for
  // an item is worth remembering; re-asking every run is how credits vanish.
  storeLookups: defineTable({
    lookupKey: v.string(),
    storeSlug: v.string(),
    itemSlug: v.string(),
    status: v.union(
      v.literal("found"),
      v.literal("none"),
      v.literal("blocked"),
    ),
    products: v.array(v.object({ title: v.string(), url: v.string() })),
    fetchedAt: v.number(),
    expiresAt: v.number(),
  }).index("by_lookup_key", ["lookupKey"]),

  // Food words learned from recipes the product has actually read.
  //
  // The static vocabulary in foodVocabulary.ts is derived from department and
  // allergen keywords, which cover staples and miss everything else — gnocchi,
  // samosa and watermelon are all absent from it. Every parsed recipe
  // contributes its ingredients here, so the vocabulary widens on its own
  // instead of waiting for someone to notice a gap.
  foodWords: defineTable({
    word: v.string(),
    firstSeenAt: v.number(),
  }).index("by_word", ["word"]),

  // Every Firecrawl *request*, which is a different limit from credits.
  //
  // The free tier allows ten requests a minute and both pipelines draw on it.
  // Pacing each loop separately could never enforce that: the recipe pipeline
  // spends its requests and then immediately triggers a coupon run, inside the
  // same minute. Same argument as creditLedger — one shared limit needs one
  // shared table.
  firecrawlRequests: defineTable({
    // When the request fires, which may be in the future: a reservation that has
    // to wait is claimed for the moment it will actually run, so a concurrent
    // reservation sees it and stacks behind it.
    at: v.number(),
    weight: v.number(),
  }).index("by_at", ["at"]),

  // Every Firecrawl credit this app spends, whichever feature spent it.
  //
  // The daily budget used to be enforced by summing recipeJobs.creditsUsed,
  // which made coupon scraping invisible to it — the brake stopped being global
  // the moment a second pipeline existed. One ledger, one total.
  creditLedger: defineTable({
    feature: v.string(),
    credits: v.number(),
    at: v.number(),
  }).index("by_at", ["at"]),
});
