# Hackathon log

- **Project:** frigid
- **Event:** Convex All Gas Hackathon
- **What it does:** An all-in-one hub for recipes and ingredients, per the repository README.
- **Live app:** not deployed
- **Repo:** https://github.com/ValNielson/frigid
- **Frontend:** Convex static hosting
- **Convex deployment:** not deployed
- **Components:** @convex-dev/static-hosting
- **Convex features:** schema, tables, indexes, queries, mutations, actions, HTTP actions
- **Auth:** none
- **AI models:** gpt-5.5
- **Started:** 2026-08-28T19:01:02Z
- **Last updated:** 2026-08-31T17:16:08Z

## Log

### 2026-08-28 - 8f6b19a
Created the repository with a README and an MIT license. No application code,
Convex backend, or frontend yet.

### 2026-08-28 - working tree
Set up the build environment and stood up the app skeleton. Installed the
official Convex plugin at user scope, added the `convex-hackathon-skill` build
log skill, and added a Stop hook that prompts this log to refresh after the
working tree changes (`.claude/`). Scaffolded Next.js 16 with Tailwind v4 and
wired the Convex client into the root layout (`app/layout.tsx`,
`app/ConvexClientProvider.tsx`). Added three third-party integrations as Node
actions: OpenAI text completion defaulting to gpt-5.5, Firecrawl page scraping,
and AgentMail inbox create/send/reply (`convex/openai.ts`,
`convex/firecrawl.ts`, `convex/agentmail.ts`). Wired the AgentMail inbound
connection as a Svix-verified webhook that records raw events deduped by event
id (`convex/http.ts`, `convex/agentmailEvents.ts`, `convex/schema.ts`). Convex
features: schema, tables, indexes, actions, mutations, HTTP actions. No product
code yet, no API keys set, and the Convex deployment is local only.

### 2026-08-31 - e9adc57
Shipped the first product surface: a branded home screen that verifies an email
address without any account or login. A visitor enters their address, gets a
6-digit code by email, and enters it to confirm the mailbox is real; the
confirmed state is stored in Convex (`app/page.tsx`,
`app/components/VerifyEmailCard.tsx`, `app/verified/page.tsx`).

Backend is a new `subscribers` table indexed by email and by unsubscribe token,
with the code stored only as a salted SHA-256 hash. Codes expire after 10
minutes and allow 5 attempts; resends are throttled by a 60-second cooldown and
5 sends per rolling hour. Random codes and tokens are generated in a `"use node"`
action because Convex mutations are deterministic and their `Math.random` is
seeded (`convex/schema.ts`, `convex/verification.ts`, `convex/subscribers.ts`,
`convex/policy.ts`).

Unsubscribe is served from the Convex HTTP router so the link works straight
from a mail client with no JavaScript. The GET only renders a confirmation and
the opt-out happens on POST, so link scanners that fetch every URL in a message
cannot silently unsubscribe anyone; `List-Unsubscribe` headers still give Gmail
its native one-click path (`convex/http.ts`, `convex/agentmail.ts`). Unknown and
already-used tokens render the same neutral page, and an unknown address is
reported exactly like a wrong code, so neither endpoint reveals who is on the
list. Convex features: schema, tables, indexes, queries, mutations, actions,
HTTP actions.

Exercised against the dev deployment through the Convex CLI and over HTTP, not
yet clicked through in a browser: send, wrong-code lockout after 5 attempts,
resend cooldown, malformed-address rejection, and the unsubscribe GET leaving
the row untouched before a POST clears it. Correction to an earlier
entry: components is `@convex-dev/static-hosting`, not none, since
`convex/convex.config.ts` registers it.
