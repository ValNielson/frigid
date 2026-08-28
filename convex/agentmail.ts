"use node";

import { AgentMailClient, type AgentMail } from "agentmail";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { requireEnv } from "./env";

function client() {
  return new AgentMailClient({ apiKey: requireEnv("AGENTMAIL_API_KEY") });
}

export const createInbox = action({
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

export const sendMessage = action({
  args: {
    inboxId: v.string(),
    to: v.array(v.string()),
    subject: v.string(),
    text: v.optional(v.string()),
    html: v.optional(v.string()),
  },
  returns: v.object({ messageId: v.string(), threadId: v.string() }),
  handler: async (_ctx, args) => {
    const { inboxId, ...message } = args;
    return await client().inboxes.messages.send(inboxId, message);
  },
});

export const replyToMessage = action({
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

export const registerWebhook = action({
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
