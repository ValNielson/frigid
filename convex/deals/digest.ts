"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { requireEnv } from "../env";

/**
 * Mails a person the coupons picked for them.
 *
 * Pure template: the reasons were written during matching, so assembling the
 * digest costs nothing. Mirrors the verification email — same shell, same
 * one-click unsubscribe headers — so both look like they come from one product.
 */

const FROM_NAME = "frigid";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const pick = v.object({
  title: v.string(),
  discount: v.optional(v.string()),
  details: v.optional(v.string()),
  code: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  reason: v.string(),
});

type Pick = {
  title: string;
  discount?: string;
  details?: string;
  code?: string;
  sourceUrl?: string;
  reason: string;
};

function buildEmail(picks: Pick[], unsubscribeUrl: string) {
  const headline =
    picks.length === 1
      ? "One deal worth your time"
      : `${picks.length} deals worth your time`;

  const text = [
    `${FROM_NAME} - ${headline}`,
    "",
    ...picks.flatMap((item) => {
      const price = item.discount === undefined ? "" : ` - ${item.discount}`;
      const lines = [`${item.title}${price}`, `  ${item.reason}`];
      if (item.code !== undefined) lines.push(`  Code: ${item.code}`);
      if (item.sourceUrl !== undefined) lines.push(`  ${item.sourceUrl}`);
      lines.push("");
      return lines;
    }),
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");

  const rows = picks
    .map((item) => {
      const price =
        item.discount === undefined
          ? ""
          : `<span style="margin-left:8px;padding:2px 8px;border-radius:999px;background:#eaf5ec;color:#2f6b43;font-size:13px;font-weight:600;">${escapeHtml(item.discount)}</span>`;
      const code =
        item.code === undefined
          ? ""
          : `<p style="margin:8px 0 0;font-size:13px;color:#3d5666;">Code <strong style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(item.code)}</strong></p>`;
      const title =
        item.sourceUrl === undefined
          ? escapeHtml(item.title)
          : `<a href="${escapeHtml(item.sourceUrl)}" style="color:#0f1b24;text-decoration:none;">${escapeHtml(item.title)}</a>`;

      return `<li style="margin:0 0 20px;padding:0 0 20px;border-bottom:1px solid #e6eef4;list-style:none;">
        <p style="margin:0;font-size:16px;font-weight:600;line-height:1.4;">${title}${price}</p>
        <p style="margin:6px 0 0;font-size:14px;line-height:1.6;color:#5d7c8f;">${escapeHtml(item.reason)}</p>
        ${code}
      </li>`;
    })
    .join("");

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f8fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f1b24;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;border:1px solid #dbe7ef;">
      <p style="margin:0 0 8px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#5d7c8f;">${FROM_NAME}</p>
      <h1 style="margin:0 0 24px;font-size:22px;line-height:1.3;">${escapeHtml(headline)}</h1>
      <ul style="margin:0;padding:0;">${rows}</ul>
      <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#7d97a7;">
        Picked for what you told us you cook.
        <a href="${escapeHtml(unsubscribeUrl)}" style="color:#7d97a7;">Unsubscribe</a>
      </p>
    </div>
  </body>
</html>`;

  return { text, html };
}

export const send = internalAction({
  args: { userId: v.id("users"), picks: v.array(pick) },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.picks.length === 0) return null;

    const inputs = await ctx.runQuery(internal.deals.data.runInputs, {
      userId: args.userId,
    });
    // Re-read rather than trusting the caller: someone can opt out between the
    // run starting and the mail going out, and the later answer is the one
    // that counts.
    if (inputs === null || !inputs.subscribed) return null;

    const siteUrl = requireEnv("CONVEX_SITE_URL").replace(/\/$/, "");
    const unsubscribeUrl = `${siteUrl}/unsubscribe?token=${encodeURIComponent(
      inputs.unsubscribeToken,
    )}`;
    const { text, html } = buildEmail(args.picks, unsubscribeUrl);

    await ctx.runAction(api.agentmail.sendMessage, {
      inboxId: requireEnv("AGENTMAIL_INBOX_ID"),
      to: [inputs.email],
      subject:
        args.picks.length === 1
          ? "A deal worth your time"
          : `${args.picks.length} deals worth your time`,
      text,
      html,
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    await ctx.runMutation(internal.deals.data.markDigestSent, {
      userId: args.userId,
      now: Date.now(),
    });

    return null;
  },
});
