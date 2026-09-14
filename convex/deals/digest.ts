"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireEnv } from "../env";
import {
  emailCard,
  escapeHtml,
  safeHref,
  unsubscribeHeaders,
  unsubscribeLine,
  unsubscribeUrl,
} from "../emailShell";

/**
 * Mails a person the coupons picked for them.
 *
 * Pure template: the reasons were written during matching, so assembling the
 * digest costs nothing. Mirrors the verification email — same shell, same
 * one-click unsubscribe headers — so both look like they come from one product.
 */

const FROM_NAME = "frigid";

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

function buildEmail(picks: Pick[], optOutUrl: string) {
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
      const href = safeHref(item.sourceUrl);
      if (href !== null) lines.push(`  ${href}`);
      lines.push("");
      return lines;
    }),
    unsubscribeLine(optOutUrl),
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
      // Source URLs come from Firecrawl search results, so the scheme is not
      // ours to assume. An unlinked title beats a link we did not vet.
      const href = safeHref(item.sourceUrl);
      const title =
        href === null
          ? escapeHtml(item.title)
          : `<a href="${escapeHtml(href)}" style="color:#0f1b24;text-decoration:none;">${escapeHtml(item.title)}</a>`;

      return `<li style="margin:0 0 20px;padding:0 0 20px;border-bottom:1px solid #e6eef4;list-style:none;">
        <p style="margin:0;font-size:16px;font-weight:600;line-height:1.4;">${title}${price}</p>
        <p style="margin:6px 0 0;font-size:14px;line-height:1.6;color:#5d7c8f;">${escapeHtml(item.reason)}</p>
        ${code}
      </li>`;
    })
    .join("");

  const html = emailCard({
    title: headline,
    maxWidthPx: 520,
    unsubscribeUrl: optOutUrl,
    body: `<ul style="margin:0;padding:0;">${rows}</ul>`,
    footer: "Picked for what you told us you cook.",
  });

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

    const optOutUrl = unsubscribeUrl(inputs.unsubscribeToken);
    const { text, html } = buildEmail(args.picks, optOutUrl);

    await ctx.runAction(internal.agentmail.sendMessage, {
      inboxId: requireEnv("AGENTMAIL_INBOX_ID"),
      to: [inputs.email],
      subject:
        args.picks.length === 1
          ? "A deal worth your time"
          : `${args.picks.length} deals worth your time`,
      text,
      html,
      headers: unsubscribeHeaders(optOutUrl),
    });

    await ctx.runMutation(internal.deals.data.markDigestSent, {
      userId: args.userId,
      now: Date.now(),
    });

    return null;
  },
});
