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

  subscribers: defineTable({
    // Normalized: trimmed and lowercased. Unique by convention, enforced by
    // always looking up through by_email before inserting.
    email: v.string(),
    verifiedAt: v.optional(v.number()),
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
});
