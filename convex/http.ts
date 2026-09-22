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

/**
 * The shell both unsubscribe screens render into.
 *
 * Deliberately a hand-written page rather than anything from `app/`: this is
 * served by Convex's HTTP router straight from a mail client, with no React and
 * no bundle, which is the whole reason the route lives here. That means the
 * design tokens have to be repeated by hand, and it is why this page spent a
 * while on an older blue-and-orange palette that shared no colour with the app.
 *
 * The values below are copied from `app/globals.css` and `app/lib/formClasses`:
 * the mint wash, the 22px white card with its plum shadow, the deep-teal pill
 * that goes plum on hover. Keep them in step when the app's palette moves.
 *
 * Light only, because the app is. `color-scheme: light` stops a dark-mode
 * browser tinting the form control and leaving one element off-brand.
 *
 * The logo is served by the static-hosting catch-all on this same origin, so it
 * costs no extra configuration — but it is only there once a frontend has been
 * deployed, hence the alt text carrying the name on its own.
 */
function page(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} · frigid</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0; min-height: 100vh; display: grid; place-items: center;
        padding: 24px; color: #554348;
        background: #fafbfb;
        background-image: linear-gradient(180deg, #d4f5f5 0%, #fafbfb 62%);
        background-repeat: no-repeat;
        /* The app's Geist is self-hosted by next/font at a hashed path this
           page cannot reference, and fetching it from Google here would add a
           third-party request at the exact moment someone is opting out. The
           system stack is the closer call: SF Pro and Segoe UI are both
           neutral grotesques and read near enough at this size. */
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
          Helvetica, Arial, sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      .card {
        width: 100%; max-width: 420px; background: #fff;
        border-radius: 22px; padding: 32px; text-align: left;
        box-shadow: 0 6px 24px rgba(85, 67, 72, 0.08);
      }
      .logo { display: block; height: 44px; width: auto; margin: 0 0 20px; }
      h1 {
        margin: 0 0 10px; font-size: 24px; line-height: 1.25;
        font-weight: 600; letter-spacing: -0.02em;
      }
      p { margin: 0 0 22px; font-size: 15px; line-height: 1.6; color: #6a6b6e; }
      /* The confirmation screen ends on a button; the done screen ends on this
         paragraph, and its trailing margin was padding the card out. */
      p:last-child { margin-bottom: 0; }
      .email { font-weight: 600; color: #554348; overflow-wrap: anywhere; }
      button {
        appearance: none; border: 0; border-radius: 999px; cursor: pointer;
        background: #46747e; color: #fff; font-size: 16px; font-weight: 600;
        padding: 12px 24px; width: 100%; transition: background .15s ease;
        font-family: inherit;
      }
      button:hover { background: #554348; }
      button:focus-visible { outline: 2px solid #46747e; outline-offset: 2px; }
      .fine { margin: 18px 0 0; font-size: 13px; color: #66757a; }
    </style>
  </head>
  <body>
    <main class="card">
      <!-- Served by the static-hosting catch-all on this origin, so it is only
           there once a frontend has been deployed — a backend-only deployment
           404s it. Removing itself on error beats a broken-image box in a
           stranger's mail client. -->
      <img class="logo" src="/frigid-logo.png" alt="frigid"
           onerror="this.remove()" />
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
