"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireEnv } from "./env";
import { renderSummaryHtml, renderSummaryText } from "./onboardingSummary";
import {
  unsubscribeHeaders,
  unsubscribeLine,
  unsubscribeUrl,
} from "./emailShell";

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

    const optOutUrl = unsubscribeUrl(data.unsubscribeToken);

    await ctx.runAction(internal.agentmail.sendMessage, {
      inboxId: requireEnv("AGENTMAIL_INBOX_ID"),
      to: [data.email],
      subject: "Your frigid taste profile",
      text: `${renderSummaryText(data.answers)}\n\n${unsubscribeLine(optOutUrl)}\n`,
      html: renderSummaryHtml(data.answers, optOutUrl),
      headers: unsubscribeHeaders(optOutUrl),
    });
    return null;
  },
});
