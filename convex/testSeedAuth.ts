"use node";

import { randomBytes } from "node:crypto";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireEnv } from "./env";
import { hashSessionToken } from "./hash";

/**
 * Mints a real session for a seeded user and hands back the raw token.
 *
 * Exists so an end-to-end check can drive the public API without the pepper
 * ever leaving the deployment: the token is generated and hashed here, exactly
 * the way verification.ts does it, and only the opaque half is stored.
 *
 * "use node" for the same reason verification.ts is — Convex mutations are
 * deterministic and must never mint a secret.
 */
export const mintSession = internalAction({
  args: { email: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args): Promise<string | null> => {
    const token = randomBytes(32).toString("base64url");
    const sessionId = await ctx.runMutation(internal.testSeed.seedSession, {
      email: args.email,
      tokenHash: await hashSessionToken(
        token,
        requireEnv("VERIFICATION_CODE_PEPPER"),
      ),
    });
    return sessionId === null ? null : token;
  },
});
