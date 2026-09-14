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
    // When the deals digest last went out, so the daily cron can tell who is
    // due without reading a second table.
    lastDigestAt: v.optional(v.number()),
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
    lastSeenAt: v.number(),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_user", ["userId"]),

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
    }),
    skippedMerchants: v.optional(v.array(v.string())),
    error: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_kind_started", ["kind", "startedAt"]),
});
