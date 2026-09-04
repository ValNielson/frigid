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
});
