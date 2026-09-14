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
  actions, crons, scheduled functions, realtime queries
- **Auth:** Other (hand-rolled emailed code plus opaque session tokens)
- **AI models:** gpt-5.5
- **Started:** 2026-08-28T19:01:02Z
- **Last updated:** 2026-09-14T17:17:20Z

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

### 2026-09-11 - 65930c5
Made the AgentMail, Firecrawl, and OpenAI integrations internal. All three had
been public actions since the scaffold, so anyone with the deployment URL could
send mail from our inbox to any address, scrape arbitrary URLs on our key, or
burn model tokens. Nothing in `app/` called them from the client, so closing it
cost nothing (`convex/agentmail.ts`, `convex/firecrawl.ts`, `convex/openai.ts`).

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

### 2026-09-11 - 17066a2
Shipped the first real product loop: type what you feel like cooking on `/home`,
and a background job searches recipe sites, reads the ingredients, builds one
deduped shopping list grouped by store department, and emails it while the
screen follows along. Verified end to end against the live APIs — real searches,
real recipes, real mail.

The job row is both the state machine and the UI model, so progress is reactive
with no polling. Four actions chained through the scheduler rather than
`@convex-dev/workflow`: that component's headline feature is automatic per-step
retries, and every retry here spends Firecrawl credits. Convex does not retry
scheduled actions on its own, so each step marks the job failed instead of
leaving it stuck. Convex features: schema, indexes, queries, mutations, internal
actions, scheduled functions, realtime queries (`convex/schema.ts`,
`convex/recipeJobs.ts`, `convex/recipeRun.ts`, `app/components/RecipeSearchCard.tsx`).

Ingredients come from the schema.org/Recipe JSON-LD that recipe sites publish
for Google, so the happy path spends no model tokens at all — every run so far
has used zero. A paid extraction fallback exists behind a per-job cap and a kill
switch, and has never fired (`convex/recipeJsonLd.ts`, `convex/recipeText.ts`).

Allergy filtering is deterministic keyword matching against the onboarding
answers, never a model call, because the onboarding email already promises
allergies are a hard rule. A test account allergic to celery correctly had every
chicken soup dropped, with the reasons shown rather than hidden.

The free Firecrawl tier is the binding constraint, so caches are keyed on
normalized content rather than on a user and one person's search warms
everyone's: a repeated search costs zero credits and finishes in ten seconds.
Firecrawl's own `maxAge` cache is deliberately unused because it bills full
price for a hit. Store lookup never fetches a retailer page — the big chains sit
behind bot walls that would bill us for a CAPTCHA — so every item gets a free
working link into that store's own search, and a paid probe only adds a real
product name on top. The email never prints a price it did not verify
(`convex/recipeCache.ts`, `convex/firecrawlClient.ts`, `convex/recipePolicy.ts`).

Running it live for the first time is what found the interesting bugs: store
probes were matching the retailers' own recipe articles as products, the
per-item store cache table existed but nothing ever wrote to it, roundup
listicles were eating a credit each and returning nothing, and Firecrawl refuses
the whole Dotdash Meredith portfolio outright. The site allowlist is hand
verified against the live API with a note not to re-add the bad ones
(`convex/recipeCatalog.ts`). `FIRECRAWL_MODE=fixture` replays real captured
responses so the UI and email can be iterated on for free
(`convex/fixtures/recipeFixtures.ts`).

Not yet checked by a human: the browser click-through of the new card. The page
builds and prerenders and the data shape is verified, but nobody has pressed the
button in a browser.

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

### 2026-09-14 - d51690b
Built the path from a stored profile to an emailed digest. A structured-output
action constrains a completion to a JSON Schema with `strict: true`, so a
malformed response fails at the call instead of downstream. Raw JSON Schema
rather than the SDK's zod helper, since zod is only present transitively
through the openai package (`convex/openai.ts`).

The planner earns its model call on the case a lookup table cannot cover. For
Grand Rapids it named Ken's Fruit Market, Kingma's, Horrocks, and the Fulton
Street Farmers Market — real local businesses. Both caches verified live: a ZIP
resolves to the right city, and a second plan request with different casing and
different write-in stores came back cached with no model call
(`convex/deals/plan.ts`).

Matching runs allergen exclusion first and deterministically, then one batched
call over every survivor rather than a call per coupon. The model refers to
candidates by position, so an out-of-range or repeated index is dropped rather
than trusted — otherwise a digest could feature a coupon that was never a
candidate (`convex/deals/match.ts`). The digest itself is a pure template and
re-reads subscription state before sending, since someone can opt out between a
run starting and its mail going out (`convex/deals/digest.ts`).

### 2026-09-14 - edf03d1
The pipeline runs end to end. One daily cron serves every email frequency by
asking per user whether enough time has passed; each due user is scheduled
separately so one failed run cannot stop everyone else's mail
(`convex/crons.ts`). Manual runs are throttled server-side — a run costs real
Firecrawl and model spend, and a disabled button is only a suggestion. The
prompt console now starts a real run (`convex/deals.ts`,
`app/components/PromptConsole.tsx`). Convex features: crons, scheduled
functions.

The typed prompt is deliberately not sent to a model. It tells us someone wants
deals now; their stored profile already answers which ones.

Verified against a seeded Grand Rapids profile: 7 merchants wanted, capped at 5
per run with the 2 dropped recorded on the run row, 87 coupons extracted, 12
matched. The run took 75 seconds, which is why it is scheduled rather than
awaited. The allergen rule was exercised against the live pool rather than
fixtures — with shellfish and tree nuts declared, a crab rangoon offer was
withheld from 75 real scraped coupons.

Still open: inbound mail extraction is unwritten because the AgentMail key
lacks `inbox_read`, so no digest has been delivered to a real mailbox yet and
the plus-addressing question that decides per-user deal signup is still
unanswered. Deal plans are cached per city, so a write-in store reaches
Firecrawl only when that city is planned for the first time.

### 2026-09-14 - 51e8718
Fixed two faults in deal planning that had to land together.

The city plan cache swallowed write-in stores. `planForLocation` returned from
cache before reading its `vagueStores` argument, so the first person to run in a
city fixed the plan for everyone after — if they did not tick "Local co-op or
farmers market" and you did, your tick did nothing, with no error and no log.
Write-ins now cache on `(location, store)` in a new `storePlans` table, so the
shared city plan stays shared and combinations never multiply
(`convex/schema.ts`, `convex/deals/plan.ts`).

Caching that would have made the second fault permanent. Checking the five
domains the model had proposed for Grand Rapids against the live web, one was
usable: one was NXDOMAIN, one published no deals page, one was a farmers market,
and `shophorrocks.com` was the right chain's Lansing store 65 miles away —
serving a current, well-formed specials page that would have been ingested as
Grand Rapids pricing with nothing looking wrong. The model now returns business
names only and Firecrawl resolves the domain; Horrocks now resolves to
`horrocksmarket.com`, the Kentwood store, and the dead domain is gone
(`convex/firecrawl.ts`).

Scraped pages from model-proposed merchants must now prove they serve the user's
metro before their coupons are kept. The check is skipped for the named chains,
whose ad pages often print no city and whose domain is already the guarantee —
asserting against them would have discarded the coupons that actually work.
Drops are counted on the run rather than silently lost. Live runs recorded 12
and 4 coupons dropped this way (`convex/deals/policy.ts`, `convex/deals/run.ts`).

Live testing caught one more: a name search for a small shop often ranks its
Yelp listing above its own site, and a directory sets no prices, so those are
filtered. Plans now expire after 30 days — `createdAt` was stored and never
read, and a domain going dark is exactly the rot needing an upper bound.

Verified: two seeded Grand Rapids profiles with different write-ins now share
one `dealPlans` row and hold two separate `storePlans` rows. 44 unit tests pass.
`convex/testSeed.ts` is committed rather than written and deleted a third time.

### 2026-09-14 - c708c90
The merchant cap was defeating the fix above. Run B resolved the user's write-in
store correctly and then dropped it: the cap took the first five of chains, then
city plan, then store plans, and store plans were appended last, so speculative
planner suggestions crowded out the shop actually asked for.

Ordering is now the chains they ticked, then the stores they named, then
whatever the planner suggested. Re-running the same profile scrapes
`indiamarketgr.com` and drops the planner's suggestions instead
(`convex/deals/run.ts`).

### 2026-09-14 - b2e8360
Settled the plus-addressing question the per-user signup branch has waited on
since this feature started, now that the AgentMail key carries `inbox_read`.

Mail sent from an external address to `frigid+plustest02@agentmail.to` arrived
in the base inbox with the tag intact in `message.to`. So one inbox can serve
many people: each gets their own tagged address to hand to merchants, and
inbound mail is attributable without creating an inbox per user. An earlier
self-send to a tagged address was accepted and never delivered back, with no
bounce, which reads as loop suppression rather than rejection — the external
test is the one that counts. Sending was confirmed the same way.

Added `listMessages`, `listWebhooks`, and `registerInboundWebhook` to do it
(`convex/agentmail.ts`). `listMessages` returns recipients verbatim, since that
is where a tag survives — `inboxId` is normalized and hides it — and returns
labels, because the listing mixes sent copies with received mail and only the
labels separate them.

Two blockers found in the process, both pointing the same way. No inbound
webhook had ever been registered: `convex/http.ts` has served a Svix-verified
route since the first week and `agentmailEvents` stayed empty for want of anyone
calling it. And registration fails because this project has only ever run on a
local Convex backend — `npx convex deployments` reports type `local`, and
`CONVEX_SITE_URL` is a loopback address AgentMail rejects as unreachable.

That also means unsubscribe links in mail already sent point at a loopback
address and do not resolve for recipients, and the `List-Unsubscribe` header
with them is equally dead. Both are fixed by the same step.

Order of work: deploy to a cloud deployment, set `CONVEX_SITE_URL` to the public
site URL, register the webhook, then build inbound extraction against real
messages. Inbound extraction stays unwritten until then.
