import { httpRouter } from "convex/server";
import { Webhook } from "svix";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { httpAction } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { requireEnv } from "./env";
import { escapeHtml } from "./emailShell";

const http = httpRouter();

/**
 * Well under Convex's 1 MB document ceiling, with room for the wrapper we add
 * around a payload we do keep.
 */
const MAX_PAYLOAD_BYTES = 512 * 1024;

/** A string field off an unknown JSON body, or null if it is not one. */
function stringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

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

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("Malformed JSON", { status: 400 });
    }

    const eventId = stringField(payload, "event_id");
    const eventType = stringField(payload, "event_type");

    // A signed request we cannot file is still one we should stop being sent.
    // These used to go straight into v.string() validators, so a payload
    // missing either threw, returned 500, and had Svix redeliver the same
    // unfileable body indefinitely. 400 says "this will never work".
    if (eventId === null || eventType === null) {
      return new Response("Missing event_id or event_type", { status: 400 });
    }

    await ctx.runMutation(internal.agentmailEvents.record, {
      eventId,
      eventType,
      // Convex documents cap at 1 MB and an inbound message with attachments
      // clears that, which would throw and again invite endless redelivery.
      // Keep the identity, record that the body was too big, drop the body.
      payload:
        body.length > MAX_PAYLOAD_BYTES
          ? { event_id: eventId, event_type: eventType, truncated: true, bytes: body.length }
          : payload,
    });

    return new Response(null, { status: 204 });
  }),
});

/* ---------------------------------------------------------------------------
 * Unsubscribe
 *
 * Served from the Convex HTTP router rather than a Next.js page so the link
 * works straight from an email client with no JavaScript and no app loaded.
 *
 * The GET only renders a confirmation; the actual opt-out happens on POST.
 * Mail providers and security appliances routinely fetch every link in a
 * message to scan it, and a mutating GET would let those scanners silently
 * unsubscribe people who never clicked.
 * ------------------------------------------------------------------------ */

function page(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} · frigid</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0; min-height: 100vh; display: grid; place-items: center;
        padding: 24px; background: #f4f8fb; color: #0f1b24;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      }
      .card {
        width: 100%; max-width: 420px; background: #fff; border: 1px solid #dbe7ef;
        border-radius: 16px; padding: 32px; text-align: left;
      }
      .brand {
        margin: 0 0 8px; font-size: 12px; letter-spacing: .08em;
        text-transform: uppercase; color: #5d7c8f;
      }
      h1 { margin: 0 0 12px; font-size: 21px; line-height: 1.3; }
      p { margin: 0 0 20px; font-size: 15px; line-height: 1.6; color: #3d5666; }
      .email { font-weight: 600; color: #0f1b24; overflow-wrap: anywhere; }
      button {
        appearance: none; border: 0; border-radius: 999px; cursor: pointer;
        background: #ef7c2f; color: #fff; font-size: 15px; font-weight: 600;
        padding: 12px 22px; width: 100%;
      }
      button:hover { background: #d96a20; }
      @media (prefers-color-scheme: dark) {
        body { background: #08131a; color: #e6f2f8; }
        .card { background: #0f2029; border-color: #1d3945; }
        p { color: #9fbccb; }
        .email { color: #e6f2f8; }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <p class="brand">frigid</p>
      ${body}
    </main>
  </body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const donePage = () =>
  page(
    "Unsubscribed",
    `<h1>You're unsubscribed</h1>
     <p>You won't receive any more emails from frigid. Nothing else to do.</p>`,
  );

http.route({
  path: "/unsubscribe",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = new URL(request.url).searchParams.get("token");
    if (token === null || token.length === 0) return donePage();

    const row = await ctx.runQuery(internal.users.getByUnsubscribeToken, {
      token,
    });

    // An unknown token gets the same neutral page as a successful opt-out, so a
    // guessed token reveals nothing about whether it exists.
    if (row === null || !row.subscribed) return donePage();

    return page(
      "Unsubscribe",
      `<h1>Unsubscribe from frigid?</h1>
       <p>We'll stop sending email to <span class="email">${escapeHtml(row.email)}</span>.</p>
       <form method="post" action="/unsubscribe">
         <input type="hidden" name="token" value="${escapeHtml(token)}" />
         <button type="submit">Confirm unsubscribe</button>
       </form>`,
    );
  }),
});

http.route({
  path: "/unsubscribe",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // The token arrives in the query string for RFC 8058 one-click POSTs from
    // Gmail/Apple Mail, and in the form body from our own confirmation page.
    let token = new URL(request.url).searchParams.get("token");
    if (token === null || token.length === 0) {
      const body = await request.text();
      token = new URLSearchParams(body).get("token");
    }

    if (token !== null && token.length > 0) {
      await ctx.runMutation(internal.users.unsubscribeByToken, {
        token,
        now: Date.now(),
      });
    }

    return donePage();
  }),
});

/**
 * The static site, as a catch-all underneath everything above.
 *
 * `convex.config.ts` registers the component without an `httpPrefix`, which is
 * the mode that leaves this router in charge of the root — chosen so
 * `/unsubscribe` and `/agentmail/webhook` keep the URLs already sitting in
 * people's inboxes and in AgentMail's webhook config. The cost of that mode is
 * this line, and without it the component is registered but never mounted:
 * every path except the two above answers "no matching routes found", which is
 * exactly what the first production deploy did.
 *
 * Registered last on purpose. Exact routes win over the catch-all, so the order
 * here is what keeps the two app routes reachable.
 */
registerStaticRoutes(http, components.staticHosting);

export default http;
