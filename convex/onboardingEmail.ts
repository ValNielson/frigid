"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { requireEnv } from "./env";
import { renderSummaryHtml, renderSummaryText } from "./onboardingSummary";

/**
 * Mails the finished taste profile. Scheduled from preferences.save rather than
 * awaited, so a mail failure never costs the user their answers or blocks the
 * redirect to the home screen.
 */
export const sendSummary = internalAction({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const data = await ctx.runQuery(internal.preferences.forSummaryEmail, {
      userId: args.userId,
    });
    if (data === null) return null;
    // Someone who has opted out does not get mail, even mail they just caused.
    if (!data.subscribed) return null;

    const siteUrl = requireEnv("CONVEX_SITE_URL").replace(/\/$/, "");
    const unsubscribeUrl = `${siteUrl}/unsubscribe?token=${encodeURIComponent(
      data.unsubscribeToken,
    )}`;

    await ctx.runAction(api.agentmail.sendMessage, {
      inboxId: requireEnv("AGENTMAIL_INBOX_ID"),
      to: [data.email],
      subject: "Your frigid taste profile",
      text: `${renderSummaryText(data.answers)}\n\nUnsubscribe: ${unsubscribeUrl}\n`,
      html: renderSummaryHtml(data.answers, unsubscribeUrl),
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    return null;
  },
});
