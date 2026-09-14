# Hackathon log

- **Project:** frigid
- **Event:** Convex All Gas Hackathon
- **What it does:** An all-in-one hub for recipes and ingredients, per the repository README.
- **Live app:** not deployed
- **Repo:** https://github.com/ValNielson/frigid
- **Frontend:** Convex static hosting
- **Convex deployment:** not deployed
- **Components:** @convex-dev/static-hosting
- **Convex features:** schema, tables, indexes, queries, mutations, actions, HTTP
  actions, scheduled functions, realtime queries
- **Auth:** Other (hand-rolled emailed code plus opaque session tokens)
- **AI models:** gpt-5.5
- **Started:** 2026-08-28T19:01:02Z
- **Last updated:** 2026-09-11T19:49:30Z

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

### 2026-09-04 - 09f10a9
Turned the mailing-list row into an account and added the onboarding
questionnaire. Verifying a code now signs you in: it mints a 32-byte token
stored only as a salted SHA-256 hash in a new `sessions` table, so the database
never holds anything replayable. A single reactive `me` query decides where you
land — unverified to `/`, verified to `/onboarding`, onboarded to `/home`
(`convex/sessions.ts`, `convex/me.ts`, `app/components/AuthGate.tsx`).
"Onboarded but not verified" is unrepresentable: `onboardedAt` is only written
by a mutation that already resolved a session.

Session hashing uses Web Crypto rather than `node:crypto`, in a shared
`convex/hash.ts`. The `me` query runs in Convex's default runtime where
`node:crypto` does not exist, and that was the only way to keep the gate a
reactive query instead of an action.

Renamed `subscribers` to `users` and added `onboardedAt` plus a denormalized
`emailFrequency` for a future digest cron. Added a `preferences` table storing
answers as a validated record, so adding a question needs no migration
(`convex/schema.ts`, `convex/users.ts`).

Onboarding is 21 questions across 6 steps, every one offering normal options
plus an optional write-in. `convex/onboardingQuestions.ts` is the single source
the wizard, the server-side validator, and the report all read, so they cannot
drift. Allergies must be answered explicitly, an empty answer and a
"no allergies" plus a named allergen are both rejected by the mutation rather
than only by the UI, and allergies render as a hard rule kept separate from
dislikes. Answers are drafted to localStorage so a refresh mid-quiz loses
nothing (`app/components/onboarding/`, `convex/preferences.ts`).

The summary report is plain TypeScript with no model call, so onboarding costs
zero OpenAI tokens. The same renderer produces the review screen and the emailed
copy, which is scheduled rather than awaited so a mail failure cannot cost a
user their answers. It also builds a `promptContext` line cached on the row —
measured at about 178 tokens on a full profile — for future recipe prompts to
inject instead of re-deriving a profile from 21 answers
(`convex/onboardingSummary.ts`, `convex/onboardingEmail.ts`). Convex features:
scheduled functions, realtime queries.

Verified: typecheck, lint, a clean production build with all five routes
prerendering static, the three tables live on the dev deployment, and the report
and prompt-context rendering exercised directly, which caught three formatting
bugs now fixed. Clicked through in a browser per the commit message, including
the returning-user case where an already-onboarded address lands straight on the
home screen instead of repeating the quiz.

### 2026-09-11 - 6fdf972
Started the coupon pipeline: the feature that finds food deals matched to the
taste profile onboarding already collects. Cut a fresh branch from main, since
the in-flight prompt-screen work predated the onboarding merge and its three
modified files had all been rewritten by it; the prompt console and shared UI
recipes carried over and `/prompt` is now gated behind `AuthGate`
(`app/prompt/page.tsx`).

Added six tables — merchants, coupons, locations, dealPlans, runs — plus
`lastDigestAt` and a `by_email_frequency` index on users that the existing
schema comment already assumed existed. Merchants and coupons are shared rather
than per-user, so one scrape of a public weekly ad serves everyone who shops
there and Firecrawl cost stays flat as users are added (`convex/schema.ts`,
`convex/deals/data.ts`).

Allergen filtering is deterministic and runs before any model sees a coupon. A
model asked to avoid allergens complies almost always, and almost always is the
wrong standard for the one rule onboarding treats as hard. Matching is
substring-based and deliberately over-broad, so "butternut squash" trips the
dairy rule (`convex/deals/policy.ts`). Convex features: schema, tables, indexes,
queries, mutations.

Verified: 27 unit tests on Node's built-in runner using its native TypeScript
support, so testing added no dependencies. Schema and all 15 data functions
deployed to the dev deployment.

### 2026-09-11 - dae0405
Coupon extraction works against real stores. Firecrawl's `json` format does the
extraction itself, so search, fetch, and structured extraction are a single call
that costs no OpenAI tokens — the earlier plan had assumed a model call per
scraped page (`convex/firecrawl.ts`).

Verified against aldi.us: 35 real offers with prices and item terms. Two defects
only live pages exposed. Extraction fills absent optional fields with empty
strings rather than omitting them, and an empty promo code stored as a real one
would be printed in a digest as something to type at the register. And these
pages mix groceries with homeware — "food only" in the prompt did not hold and
the first run returned LED ghosts, while asking for an `isFood` boolean per row
does hold.

Tests now run the allergen rule against verbatim extracted titles, including
that teriyaki is withheld for a soy allergy though it never says soy, and that
"gluten free" trips the gluten rule. The second is over-exclusion in the safe
direction with a real cost to the user, pinned by a test rather than left to be
discovered later. 32 tests passing.

Not yet working: the planner, taste matching, the digest, and inbound mail
extraction all wait on `OPENAI_API_KEY` and `AGENTMAIL_API_KEY`, which are not
set on the dev deployment. Whether AgentMail delivers plus-addressed mail is
still unverified and decides whether per-user deal signup ships at all.

