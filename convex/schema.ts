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
  })
    .index("by_email", ["email"])
    .index("by_unsubscribe_token", ["unsubscribeToken"]),

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
    source: v.union(v.literal("jsonld"), v.literal("markdown"), v.literal("llm")),
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
    status: v.union(v.literal("found"), v.literal("none"), v.literal("blocked")),
    products: v.array(v.object({ title: v.string(), url: v.string() })),
    fetchedAt: v.number(),
    expiresAt: v.number(),
  }).index("by_lookup_key", ["lookupKey"]),
});
