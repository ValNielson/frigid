import { v } from "convex/values";
import { query } from "./_generated/server";
import { userForToken } from "./sessions";

/**
 * The single thing the frontend gates on. Reactive, so revoking a session or
 * finishing onboarding moves every open tab without a reload.
 *
 * Returns null for an absent, unknown, or expired token rather than throwing,
 * because "signed out" is an ordinary state, not an error.
 */
export const me = query({
  args: { sessionToken: v.optional(v.string()) },
  returns: v.union(
    v.null(),
    v.object({
      email: v.string(),
      verified: v.boolean(),
      onboarded: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const user = await userForToken(ctx, args.sessionToken);
    if (user === null) return null;
    return {
      email: user.email,
      verified: user.verifiedAt !== undefined,
      onboarded: user.onboardedAt !== undefined,
    };
  },
});
