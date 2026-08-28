import { httpRouter } from "convex/server";
import { Webhook } from "svix";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireEnv } from "./env";

const http = httpRouter();

http.route({
  path: "/agentmail/webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.text();
    const webhook = new Webhook(requireEnv("AGENTMAIL_WEBHOOK_SECRET"));

    try {
      webhook.verify(body, {
        "svix-id": request.headers.get("svix-id") ?? "",
        "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
        "svix-signature": request.headers.get("svix-signature") ?? "",
      });
    } catch {
      return new Response("Invalid signature", { status: 400 });
    }

    const payload = JSON.parse(body);
    await ctx.runMutation(internal.agentmailEvents.record, {
      eventId: payload.event_id,
      eventType: payload.event_type,
      payload,
    });

    return new Response(null, { status: 204 });
  }),
});

export default http;
