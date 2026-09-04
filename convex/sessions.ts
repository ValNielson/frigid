import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { hashSessionToken, SESSION_TTL_MS } from "./hash";
import { requireEnv } from "./env";

/**
 * Session storage. Runs in the default runtime, so it never generates a token
 * itself — tokens come from the "use node" side already hashed, exactly the way
 * verification codes do.
 */

/**
 * Resolves a raw token to its user, or null if the token is unknown or expired.
 *
 * Shared by the `me` query and by every mutation that acts on behalf of a user,
 * so there is exactly one place that decides whether a caller is signed in.
 * Callers pass the raw token; nothing downstream ever trusts a client-supplied
 * email.
 */
export async function userForToken(
  ctx: QueryCtx,
  token: string | undefined,
): Promise<Doc<"users"> | null> {
  if (token === undefined || token.length === 0) return null;

  const tokenHash = await hashSessionToken(
    token,
    requireEnv("VERIFICATION_CODE_PEPPER"),
  );
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();

  if (session === null) return null;
  if (session.expiresAt <= Date.now()) return null;

  const user = await ctx.db.get(session.userId);
  // A verified user is the only kind that can hold a session, but re-check
  // rather than assume, so revoking verification revokes access.
  if (user === null || user.verifiedAt === undefined) return null;
  return user;
}

export const create = internalMutation({
  args: { userId: v.id("users"), tokenHash: v.string(), now: v.number() },
  returns: v.id("sessions"),
  handler: async (ctx, args): Promise<Id<"sessions">> => {
    return await ctx.db.insert("sessions", {
      userId: args.userId,
      tokenHash: args.tokenHash,
      expiresAt: args.now + SESSION_TTL_MS,
      createdAt: args.now,
      lastSeenAt: args.now,
    });
  },
});

/** Idempotent: revoking an unknown or already-revoked token is a no-op. */
export const revoke = internalMutation({
  args: { tokenHash: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (session !== null) await ctx.db.delete(session._id);
    return null;
  },
});

/** Looks up the user id for an email, for the action that mints a session. */
export const userIdForEmail = internalQuery({
  args: { email: v.string() },
  returns: v.union(
    v.object({ userId: v.id("users"), onboarded: v.boolean() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    if (user === null || user.verifiedAt === undefined) return null;
    return { userId: user._id, onboarded: user.onboardedAt !== undefined };
  },
});
