"use node";

import { AgentMailClient, type AgentMail } from "agentmail";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { requireEnv } from "./env";

function client() {
  return new AgentMailClient({ apiKey: requireEnv("AGENTMAIL_API_KEY") });
}

export const createInbox = internalAction({
  args: {
    username: v.optional(v.string()),
    domain: v.optional(v.string()),
    displayName: v.optional(v.string()),
  },
  returns: v.object({ inboxId: v.string(), email: v.string() }),
  handler: async (_ctx, args) => {
    const inbox = await client().inboxes.create(args);
    return { inboxId: inbox.inboxId, email: inbox.email };
  },
});

/** Lists inboxes so the configured AGENTMAIL_INBOX_ID can be confirmed. */
export const listInboxes = internalAction({
  args: {},
  returns: v.array(v.object({ inboxId: v.string(), email: v.string() })),
  handler: async () => {
    const response = await client().inboxes.list();
    return response.inboxes.map((inbox) => ({
      inboxId: inbox.inboxId,
      email: inbox.email,
    }));
  },
});

export const sendMessage = internalAction({
  args: {
    inboxId: v.string(),
    to: v.array(v.string()),
    subject: v.string(),
    text: v.optional(v.string()),
    html: v.optional(v.string()),
    headers: v.optional(v.record(v.string(), v.string())),
  },
  returns: v.object({ messageId: v.string(), threadId: v.string() }),
  handler: async (_ctx, args) => {
    const { inboxId, ...message } = args;
    return await client().inboxes.messages.send(inboxId, message);
  },
});

export const replyToMessage = internalAction({
  args: {
    inboxId: v.string(),
    messageId: v.string(),
    text: v.optional(v.string()),
    html: v.optional(v.string()),
  },
  returns: v.object({ messageId: v.string(), threadId: v.string() }),
  handler: async (_ctx, args) => {
    const { inboxId, messageId, ...reply } = args;
    return await client().inboxes.messages.reply(inboxId, messageId, reply);
  },
});

export const registerWebhook = internalAction({
  args: {
    url: v.string(),
    eventTypes: v.array(v.string()),
    inboxIds: v.optional(v.array(v.string())),
  },
  returns: v.object({ webhookId: v.string(), url: v.string() }),
  handler: async (_ctx, args) => {
    const webhook = await client().webhooks.create({
      url: args.url,
      eventTypes: args.eventTypes as AgentMail.EventType[],
      inboxIds: args.inboxIds,
    });
    return { webhookId: webhook.webhookId, url: webhook.url };
  },
});

/**
 * Lists recent messages in an inbox.
 *
 * Returns the recipient list verbatim, because that is where a plus-tag lives
 * if AgentMail preserves one — `inboxId` is normalized and would not show it.
 */
export const listMessages = internalAction({
  args: { inboxId: v.string(), limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      messageId: v.string(),
      from: v.string(),
      to: v.array(v.string()),
      subject: v.union(v.string(), v.null()),
      timestamp: v.union(v.string(), v.null()),
      // Distinguishes a received message from our own sent copy, which the
      // listing returns alongside it.
      labels: v.array(v.string()),
    }),
  ),
  handler: async (_ctx, args) => {
    const response = await client().inboxes.messages.list(args.inboxId, {
      limit: args.limit ?? 20,
    });
    return response.messages.map((message) => ({
      messageId: message.messageId,
      from: message.from,
      to: message.to ?? [],
      subject: message.subject ?? null,
      timestamp:
        message.timestamp === undefined ? null : String(message.timestamp),
      labels: message.labels ?? [],
    }));
  },
});

/** Lists registered webhooks, so inbound delivery can be confirmed as wired. */
export const listWebhooks = internalAction({
  args: {},
  returns: v.array(
    v.object({
      webhookId: v.string(),
      url: v.string(),
      eventTypes: v.array(v.string()),
    }),
  ),
  handler: async () => {
    const response = await client().webhooks.list();
    return response.webhooks.map((webhook) => ({
      webhookId: webhook.webhookId,
      url: webhook.url,
      eventTypes: (webhook.eventTypes ?? []).map(String),
    }));
  },
});

/**
 * Points AgentMail's inbound webhook at this deployment.
 *
 * A convenience over registerWebhook so the URL comes from the deployment
 * itself rather than being retyped, which is how a staging webhook ends up
 * aimed at production. Safe to re-run: AgentMail returns the existing
 * registration for a URL it already has.
 */
export const registerInboundWebhook = internalAction({
  args: {},
  returns: v.object({ webhookId: v.string(), url: v.string() }),
  handler: async () => {
    const siteUrl = requireEnv("CONVEX_SITE_URL").replace(/\/$/, "");
    const webhook = await client().webhooks.create({
      url: `${siteUrl}/agentmail/webhook`,
      eventTypes: ["message.received"] as AgentMail.EventType[],
    });
    return { webhookId: webhook.webhookId, url: webhook.url };
  },
});
