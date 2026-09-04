"use node";

import { createHash, randomBytes, randomInt } from "node:crypto";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { requireEnv } from "./env";
import { CODE_LENGTH, CODE_TTL_MS, normalizeEmail } from "./policy";
import { hashSessionToken } from "./hash";

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEmail(code: string, unsubscribeUrl: string) {
  const minutes = Math.round(CODE_TTL_MS / 60000);
  const text = [
    `Your ${FROM_NAME} verification code is ${code}`,
    "",
    `Enter it on the site to confirm your email address. The code expires in ${minutes} minutes.`,
    "",
    "If you did not ask for this, you can ignore this email.",
    "",
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f8fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f1b24;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;border:1px solid #dbe7ef;">
      <p style="margin:0 0 8px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#5d7c8f;">${FROM_NAME}</p>
      <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">Confirm your email</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#3d5666;">
        Enter this code to finish verifying your address. It expires in ${minutes} minutes.
      </p>
      <p style="margin:0 0 24px;font-size:34px;font-weight:700;letter-spacing:.28em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#0f1b24;">
        ${escapeHtml(code)}
      </p>
      <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#5d7c8f;">
        If you did not ask for this, you can safely ignore this email.
      </p>
      <hr style="border:none;border-top:1px solid #e6eef4;margin:0 0 16px;" />
      <p style="margin:0;font-size:12px;line-height:1.6;color:#7d97a7;">
        <a href="${escapeHtml(unsubscribeUrl)}" style="color:#7d97a7;">Unsubscribe from frigid emails</a>
      </p>
    </div>
  </body>
</html>`;

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
      const siteUrl = requireEnv("CONVEX_SITE_URL").replace(/\/$/, "");
      const unsubscribeUrl = `${siteUrl}/unsubscribe?token=${encodeURIComponent(
        decision.unsubscribeToken,
      )}`;
      const { text, html } = buildEmail(code, unsubscribeUrl);

      await ctx.runAction(api.agentmail.sendMessage, {
        inboxId: requireEnv("AGENTMAIL_INBOX_ID"),
        to: [email],
        subject: `Your ${FROM_NAME} verification code is ${code}`,
        text,
        html,
        // Lets Gmail and Apple Mail offer their native one-click unsubscribe,
        // which POSTs and so is not tripped by link scanners.
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
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
