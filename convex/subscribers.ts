import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  CODE_TTL_MS,
  MAX_SENDS_PER_WINDOW,
  MAX_VERIFY_ATTEMPTS,
  RESEND_COOLDOWN_MS,
  SEND_WINDOW_MS,
  constantTimeEquals,
} from "./policy";

/**
 * Internal data layer for email verification.
 *
 * Everything here runs in Convex's default (deterministic) runtime, where
 * Math.random() is seeded and must never be used for secrets. All randomness
 * and hashing happens in verification.ts and arrives here pre-computed.
 */

const verifyStatus = v.union(
  v.literal("verified"),
  v.literal("invalid"),
  v.literal("expired"),
  v.literal("too_many_attempts"),
);

/**
 * Creates the subscriber row if needed and, subject to the cooldown and the
 * rolling-window cap, arms a new verification code.
 *
 * Returns whether the caller should actually send an email. The code is
 * generated before we know the answer (it is cheap); when `send` is false the
 * previously issued code is deliberately left intact so a user who is still
 * typing it is not cut off by their own impatient second request.
 */
export const issueCode = internalMutation({
  args: {
    email: v.string(),
    codeHash: v.string(),
    unsubscribeToken: v.string(),
    now: v.number(),
  },
  returns: v.object({
    send: v.boolean(),
    cooldownSeconds: v.number(),
    unsubscribeToken: v.string(),
  }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();

    const defaultCooldown = Math.ceil(RESEND_COOLDOWN_MS / 1000);

    if (existing === null) {
      await ctx.db.insert("subscribers", {
        email: args.email,
        subscribed: true,
        unsubscribeToken: args.unsubscribeToken,
        codeHash: args.codeHash,
        codeExpiresAt: args.now + CODE_TTL_MS,
        attemptsRemaining: MAX_VERIFY_ATTEMPTS,
        lastSentAt: args.now,
        sendsInWindow: 1,
        windowStartedAt: args.now,
      });
      return {
        send: true,
        cooldownSeconds: defaultCooldown,
        unsubscribeToken: args.unsubscribeToken,
      };
    }

    // Still cooling down from the last send.
    const sinceLastSend = args.now - (existing.lastSentAt ?? 0);
    if (sinceLastSend < RESEND_COOLDOWN_MS) {
      return {
        send: false,
        cooldownSeconds: Math.ceil((RESEND_COOLDOWN_MS - sinceLastSend) / 1000),
        unsubscribeToken: existing.unsubscribeToken,
      };
    }

    // Roll the window forward if it has elapsed.
    const windowExpired = args.now - existing.windowStartedAt >= SEND_WINDOW_MS;
    const windowStartedAt = windowExpired ? args.now : existing.windowStartedAt;
    const sendsInWindow = windowExpired ? 0 : existing.sendsInWindow;

    if (sendsInWindow >= MAX_SENDS_PER_WINDOW) {
      const waitMs = windowStartedAt + SEND_WINDOW_MS - args.now;
      return {
        send: false,
        cooldownSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
        unsubscribeToken: existing.unsubscribeToken,
      };
    }

    await ctx.db.patch(existing._id, {
      codeHash: args.codeHash,
      codeExpiresAt: args.now + CODE_TTL_MS,
      attemptsRemaining: MAX_VERIFY_ATTEMPTS,
      lastSentAt: args.now,
      sendsInWindow: sendsInWindow + 1,
      windowStartedAt,
    });

    return {
      send: true,
      cooldownSeconds: defaultCooldown,
      unsubscribeToken: existing.unsubscribeToken,
    };
  },
});

/**
 * Checks a submitted code hash against the armed one, spending an attempt on
 * failure. Verifying is also what opts the address back into email, since
 * asking for and completing a code is an affirmative act of consent.
 */
export const consumeCode = internalMutation({
  args: { email: v.string(), codeHash: v.string(), now: v.number() },
  returns: v.object({ status: verifyStatus }),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();

    // Unknown address is reported the same as a wrong code, so this cannot be
    // used to discover who is on the list.
    if (row === null) return { status: "invalid" as const };

    // No code armed: either already used or never issued.
    if (row.codeHash === undefined || row.codeExpiresAt === undefined) {
      return {
        status: row.verifiedAt !== undefined ? ("verified" as const) : ("invalid" as const),
      };
    }

    if (args.now > row.codeExpiresAt) return { status: "expired" as const };
    if (row.attemptsRemaining <= 0) return { status: "too_many_attempts" as const };

    if (!constantTimeEquals(row.codeHash, args.codeHash)) {
      const attemptsRemaining = row.attemptsRemaining - 1;
      await ctx.db.patch(row._id, { attemptsRemaining });
      return {
        status: attemptsRemaining <= 0 ? ("too_many_attempts" as const) : ("invalid" as const),
      };
    }

    await ctx.db.patch(row._id, {
      verifiedAt: row.verifiedAt ?? args.now,
      subscribed: true,
      unsubscribedAt: undefined,
      codeHash: undefined,
      codeExpiresAt: undefined,
      attemptsRemaining: 0,
    });
    return { status: "verified" as const };
  },
});

/** Backs the unsubscribe confirmation page. */
export const getByUnsubscribeToken = internalQuery({
  args: { token: v.string() },
  returns: v.union(
    v.object({ email: v.string(), subscribed: v.boolean() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_unsubscribe_token", (q) => q.eq("unsubscribeToken", args.token))
      .unique();
    if (row === null) return null;
    return { email: row.email, subscribed: row.subscribed };
  },
});

/** Idempotent: unsubscribing an already-unsubscribed or unknown token is a no-op. */
export const unsubscribeByToken = internalMutation({
  args: { token: v.string(), now: v.number() },
  returns: v.object({ email: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("subscribers")
      .withIndex("by_unsubscribe_token", (q) => q.eq("unsubscribeToken", args.token))
      .unique();
    if (row === null) return { email: null };

    if (row.subscribed) {
      await ctx.db.patch(row._id, { subscribed: false, unsubscribedAt: args.now });
    }
    return { email: row.email };
  },
});
