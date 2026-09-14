"use node";

import { createHash, randomBytes, randomInt } from "node:crypto";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireEnv } from "./env";
import { CODE_LENGTH, CODE_TTL_MS, normalizeEmail } from "./policy";
import { hashSessionToken } from "./hash";
import {
  emailCard,
  escapeHtml,
  unsubscribeHeaders,
  unsubscribeLine,
  unsubscribeUrl,
} from "./emailShell";

/**
 * Public entry points for email verification.
 *
 * This file is "use node" specifically so code and token generation can use
 * node:crypto. Convex mutations are deterministic (Math.random is seeded), so
 * secrets must originate here and be passed into the data layer already hashed.
 */

const FROM_NAME = "frigid";

function hashCode(code: string): string {
  const pepper = requireEnv("VERIFICATION_CODE_PEPPER");
  return createHash("sha256").update(`${code}:${pepper}`).digest("hex");
}

function generateCode(): string {
  const max = 10 ** CODE_LENGTH;
  return String(randomInt(0, max)).padStart(CODE_LENGTH, "0");
}

function buildEmail(code: string, optOutUrl: string) {
  const minutes = Math.round(CODE_TTL_MS / 60000);
  const text = [
    `Your ${FROM_NAME} verification code is ${code}`,
    "",
    `Enter it on the site to confirm your email address. The code expires in ${minutes} minutes.`,
    "",
    "If you did not ask for this, you can ignore this email.",
    "",
    unsubscribeLine(optOutUrl),
  ].join("\n");

  const html = emailCard({
    title: "Confirm your email",
    // 480 rather than the default: a six-digit code in a wide card reads as an
    // empty page with a number in it.
    maxWidthPx: 480,
    unsubscribeUrl: optOutUrl,
    body: `
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#3d5666;">
        Enter this code to finish verifying your address. It expires in ${minutes} minutes.
      </p>
      <p style="margin:0 0 24px;font-size:34px;font-weight:700;letter-spacing:.28em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#0f1b24;">
        ${escapeHtml(code)}
      </p>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#5d7c8f;">
        If you did not ask for this, you can safely ignore this email.
      </p>`,
  });

  return { text, html };
}

/**
 * Issues a verification code and emails it. Also serves "resend" — the client
 * calls this again and the cooldown in issueCode does the throttling.
 *
 * The response is intentionally identical whether the address is new, already
 * known, already verified, or currently throttled, so this cannot be used to
 * probe who is on the list.
 */
type RequestCodeResult = {
  ok: boolean;
  cooldownSeconds: number;
  error?: "invalid_email";
};

export const requestCode = action({
  args: { email: v.string() },
  returns: v.object({
    ok: v.boolean(),
    cooldownSeconds: v.number(),
    error: v.optional(v.literal("invalid_email")),
  }),
  handler: async (ctx, args): Promise<RequestCodeResult> => {
    const email = normalizeEmail(args.email);
    if (email === null) {
      return { ok: false, cooldownSeconds: 0, error: "invalid_email" as const };
    }

    const code = generateCode();
    const decision = await ctx.runMutation(internal.users.issueCode, {
      email,
      codeHash: hashCode(code),
      unsubscribeToken: randomBytes(32).toString("base64url"),
      now: Date.now(),
    });

    if (decision.send) {
      const optOutUrl = unsubscribeUrl(decision.unsubscribeToken);
      const { text, html } = buildEmail(code, optOutUrl);

      await ctx.runAction(internal.agentmail.sendMessage, {
        inboxId: requireEnv("AGENTMAIL_INBOX_ID"),
        to: [email],
        subject: `Your ${FROM_NAME} verification code is ${code}`,
        text,
        html,
        headers: unsubscribeHeaders(optOutUrl),
      });
    }

    return { ok: true, cooldownSeconds: decision.cooldownSeconds };
  },
});

type VerifyStatus = "verified" | "invalid" | "expired" | "too_many_attempts";

type VerifyResult = {
  status: VerifyStatus;
  sessionToken?: string;
  onboarded?: boolean;
};

/**
 * Checks the code and, on success, mints a session.
 *
 * Only the "verified" branch returns anything extra. Every other status is byte
 * for byte what it was before, so the deliberate property that an unknown
 * address is indistinguishable from a wrong code survives.
 */
export const verifyCode = action({
  args: { email: v.string(), code: v.string() },
  returns: v.object({
    status: v.union(
      v.literal("verified"),
      v.literal("invalid"),
      v.literal("expired"),
      v.literal("too_many_attempts"),
    ),
    sessionToken: v.optional(v.string()),
    onboarded: v.optional(v.boolean()),
  }),
  handler: async (ctx, args): Promise<VerifyResult> => {
    const email = normalizeEmail(args.email);
    const code = args.code.trim();
    if (email === null || code.length === 0) {
      return { status: "invalid" as const };
    }

    const { status } = await ctx.runMutation(internal.users.consumeCode, {
      email,
      codeHash: hashCode(code),
      now: Date.now(),
    });
    if (status !== "verified") return { status };

    const found = await ctx.runQuery(internal.sessions.userIdForEmail, { email });
    // consumeCode just set verifiedAt, so this cannot normally miss. Treat a
    // miss as a failed sign-in rather than pretending there is a session.
    if (found === null) return { status: "invalid" as const };

    const sessionToken = randomBytes(32).toString("base64url");
    await ctx.runMutation(internal.sessions.create, {
      userId: found.userId,
      tokenHash: await hashSessionToken(
        sessionToken,
        requireEnv("VERIFICATION_CODE_PEPPER"),
      ),
      now: Date.now(),
    });

    return { status: "verified" as const, sessionToken, onboarded: found.onboarded };
  },
});

/** Idempotent, and deliberately silent about whether the token existed. */
export const signOut = action({
  args: { sessionToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.sessions.revoke, {
      tokenHash: await hashSessionToken(
        args.sessionToken,
        requireEnv("VERIFICATION_CODE_PEPPER"),
      ),
    });
    return null;
  },
});
