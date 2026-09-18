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
- **Last updated:** 2026-09-18T19:07:00Z

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

Mail sent from an external address to a plus-tagged form of the project inbox arrived
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

### 2026-09-14 - 55ab193
Found and fixed the reason this project had burned 35% of its monthly Firecrawl
allowance. `run.ts` wrote `lastScrapedAt` after every scrape and never read it —
`merchantsNeedingScrape` existed, had unit tests, and had no caller — so the
24-hour TTL never once prevented a call and every run re-scraped every merchant
at full price.

The price was higher than assumed. Measured against the live account rather than
estimated: one coupon search at limit 2 costs 12 credits, not the 2 a plain
search would be, because the `json` format runs server-side extraction on every
result. A five-merchant run is therefore about 60 credits out of 1,000 a month.

Fixed by creating the merchant row before the search instead of after, so its
freshness can be consulted while there is still a call to save. A repeat run now
costs 7 credits instead of ~60, skips fresh merchants, and still matches the same
coupons from the stored pool. Added a `creditBalance` action so the account's
real number is readable, recorded the measured cost as a constant, and counted
`merchantsFresh` on the run so the saving is visible rather than assumed
(`convex/deals/run.ts`, `convex/deals/policy.ts`, `convex/firecrawl.ts`).

### 2026-09-14 - c8eec47
Brought the recipe search and coupon discovery branches together. They were built
in parallel with no knowledge of each other and do not collide on table names —
all 15 tables coexist — but they collided on direction, and that part git could
not see.

The recipe branch had closed the public API surface on the three SDK wrappers.
The deals branch, written against the older public versions, had added eight more
public actions, including one that sends mail. Only `schema.ts` and this log
conflicted; `agentmail.ts`, `openai.ts`, and `firecrawl.ts` all auto-merged into
code that compiled and would have failed at runtime, because the digest still
called a public `sendMessage` that no longer existed. Every SDK wrapper is now
internal and every coupon call site reads through the internal API, so the
lockdown covers the newer surface too.

Merged rather than rebased: eleven commits each touching `schema.ts` would have
meant resolving one conflict eleven times with a chance to get it wrong on each
pass. Verified after the merge — typecheck, lint, 44 tests, a clean production
build, and a coupon run that still completes and still withholds an allergen.

### 2026-09-14 - 007c84b
Put both pipelines on one Firecrawl credit ledger. The daily budget had been
enforced by summing recipe job rows, so coupon discovery was invisible to it —
the global brake stopped being global the moment a second pipeline existed, and
both draw on the same monthly allowance.

One `creditLedger` table now takes writes from both and the recipe budget guard
reads the shared total. Recipe spend is mirrored inside `markStatus` rather than
at its three call sites, so a fourth place that spends a credit cannot forget to
declare it. Verified against the live account: a run that actually paid spent 16
credits and the ledger recorded 16 (`convex/credits.ts`, `convex/recipeJobs.ts`,
`convex/deals/run.ts`).

### 2026-09-14 - 431be03
Reviewed the merged branch and fixed what the review turned up. The serious one
was an authentication bypass: `consumeCode` reported `verified` whenever no code
was armed and the address had been verified before, and verifying is what mints
a session — so anyone who knew a registered address could sign in with any code
at all. The branch was written when "verified" was a subscription flag that
returned no credential, and adding sessions on top never revisited it. It now
returns `invalid`, which is also what an unknown address gets, so the property
that this cannot be used to enumerate the list survives
(`convex/users.ts`, `convex/policy.ts`).

The shared credit ledger now has an actual brake behind it. `withinBudget` was
written last commit and never called, and the coupon pipeline — the heavier of
the two, at about 60 credits a run — never read it, so the cron could spend past
the daily budget without limit. It is checked before a run starts and again
inside the merchant loop. Both public entry points now share one guard;
`findForIngredients` previously enforced nothing at all. The run row is also
created by the mutation rather than the scheduled action, because a cooldown
that reads a row the action has not written yet is not a cooldown
(`convex/deals.ts`, `convex/deals/run.ts`, `convex/crons.ts`).

Two allergen tables had been maintained separately and disagreed in eleven of
twelve categories, while both files described allergens as a hard rule. Recipes
did not know teriyaki is soy, dijon is mustard, or hummus is sesame; coupons did
not know soy sauce is wheat. Merged to their union in `convex/allergens.ts`,
which is the only merge consistent with what both files already said they were
for.

Smaller corrections from the same pass: the coupon pool was reading the oldest
500 rows because Convex orders ascending by default, so everything scraped past
that cap was paid for and never matched; digest cadence is now stamped when a
run starts, since a run that matched nothing sent no mail and left the user due
again every day regardless of the cadence they chose; the free-text location is
flattened and the model's answer validated before it becomes a shared cache key;
sessions expire in seven days instead of thirty and a cron prunes them; the
webhook rejects an unfileable payload with a 400 instead of a 500 that Svix
would redeliver forever.

Cleanup the review asked for: the second Firecrawl client is gone, merged into
`firecrawlClient.ts` so every paid call records its own credit — that split was
what made the budget hole possible. Five copies of `escapeHtml` and four of the
unsubscribe URL collapsed into `convex/emailShell.ts`; the copies had already
drifted, with only one of the five escaping a single quote.

Tests went from 44 to 131 and moved to vitest, with `convex-test` driving real
Convex functions against an in-memory database. Each security fix has a
regression test that was checked by reverting the fix and watching it fail.
Typecheck, lint, and a production build are clean.

Then connected the two halves of the product, which had shipped disconnected.
`deals.findForIngredients` had no callers at all despite its own comment calling
it "the seam for the recipe-search work", and the recipe pipeline never mentioned
coupons — so a finished recipe search returned a shopping list and no deals.

`attachDeals` is now a fifth pipeline step. A warm coupon pool is a database read
and a substring match, so it runs inline and the email goes out carrying deals. A
city nobody has scraped yet is a real coupon run, so that is scheduled rather
than awaited and the run writes the deals back and releases the email itself —
awaiting it inside the step would have frozen the job's `updatedAt` past the
stall threshold and made a working job report itself as dead. The step is
deliberately not wrapped in the pipeline's `guard()` helper: that marks a job
failed on any throw, and deals are a bonus while the recipes are what was asked
for, so every failure path still sends the email
(`convex/recipeRun.ts`, `convex/recipeJobs.ts`, `convex/deals/run.ts`).

Fixed a bug found by reading the arguments of a live Firecrawl call: `run.ts`
picked `planQueries[0]` once outside the merchant loop, so every merchant was
searched with the same generic city query and the planner's merchant-specific
queries were never read. A wine shop was being asked for "grocery weekly ads"
and returning nothing while still costing a call. Each merchant now gets a query
built from its own name and place, and chain rows named after their domain drop
the TLD so the search is for "meijer" rather than "meijer.com".

Also consolidated two guards that had drifted. `blockedFromRunning` lived inside
one mutation file and could not be read from an action, so the new deals step
would have walked around the cooldown and budget the same way
`findForIngredients` once did; it is now a single internal query all three entry
points read. `credits.ts` had the ledger sum written twice, which is also what
had made a one-read guard awkward; both queries now share one function.

Tests are at 143. The seam is covered end to end in `convex-test` — warm match,
cold hand-off, allergen exclusion, budget refusal, and the rule that a deals
failure still leaves the recipes intact.

Then ran it for real, as a Cleveland cook asking for buffalo chicken dip. Four
recipes came back parsed from JSON-LD, a nineteen-item shopping list combined
across them, and an email arrived. It also exposed three things no unit test was
going to find.

The one deal it attached was a Grand Rapids coupon shown to a Cleveland shopper.
`merchants` is keyed on domain alone and the metro check was deliberately skipped
for chains on the reasoning that "the domain is already the guarantee" — which is
not true of a regional weekly ad. Worse, the leak hid itself: the deals step
decides whether to scrape by asking whether the pool is empty, and the pool
looked full, so Cleveland was never scraped at all and `kroger.com` was never
created. Coupons now carry a `metroKey`, the dedupe key includes it so one
chain's ads in two cities stop overwriting each other, and scrape freshness moved
to a `merchantScrapes` row per merchant *and* metro — on the merchant row it was
global, so reading Kroger in one city marked it fresh in every other.

The deal was also a bad match: the shopping list said "cheddar" and it returned
Goldfish Cheddar Crackers, because matching swept the whole title and the word is
genuinely in there. The extraction now also returns `primaryItem` — the single
food an offer is actually for, "cracker" rather than "cheddar" — and matching
reads that. It rides the extraction call already being paid for.

And the pool was full of things nobody eats: BBQ tools, a crockpot, fifty pounds
of dog food. The filter kept any row whose `isFood` was not explicitly false
while the extraction prompt told the model to leave fields out when unsure, so an
omission read as "keep". The two halves now agree, and a deterministic non-food
term list backs up the model's answer — the same reason the allergen rule has
never been delegated to one.

The re-run proved each of those: no Michigan coupons, Kroger scraped for
Cleveland, no non-food stored, and four deals that belong on the list — chicken
breast, cheese slices, two sauces — all Cleveland, for zero credits, because by
then the pool was warm and matching is a database read.

It found one more bug on the way. The cold run died on a Firecrawl rate limit
after four merchants: fixing per-metro freshness meant merchants that used to be
skipped as fresh now genuinely scrape, and the loop burst past the free tier's
ten requests a minute. The recipe pipeline already paces its scrapes for exactly
this reason; the coupon loop paced nothing. It does now, and one merchant failing
costs only that merchant rather than aborting a run and discarding twenty coupons
already read. The safety net from earlier held while this was broken — the run
died, the job still released its email, and the recipes still arrived.

Fixed the prices next. Weekly-ad pages render cents as superscript and
extraction flattens "$1.49" to "$149", so a live run stored barbecue sauce at
$149 and chicken at $399. No food costs over a hundred dollars, so a bare dollar
amount that large is a missing decimal; it is repaired where the extracted
fields are already normalized, and a figure still absurd afterwards is dropped
rather than printed. That is the rule the recipe email already stated about
never quoting a price it cannot stand behind, finally applied to the deals
section too.

Then replaced the rate-limit fix from earlier in the session, which was wrong.
Spacing one loop cannot govern a limit two pipelines share: the recipe pipeline
spends its requests and then immediately triggers a coupon run, inside the same
minute, which is exactly how the first Cleveland cold run died. Requests now go
through one shared limiter — a table both features write to, in the same spirit
as the credit ledger, and for the same reason. Reserving and counting happen in
a single mutation, because reading a count, sleeping, and then recording lets
two callers both see room and both fire; Convex's optimistic concurrency makes
two reservations that read the same window conflict, and the loser retries
against the updated count. Firecrawl's own retry-after is honoured as a backstop
for when the per-call weights are wrong, which is cheap because a rejected
request is never billed. Both hand-tuned spacing constants are gone; they were
stand-ins for this.

The San Diego run that was meant to prove all of it did not. The recipe half
worked — two Mediterranean recipes, a twenty-four item list, and the planner
finding real San Diego stores — and the coupon run completed cleanly instead of
crashing, which is the improvement the limiter was for. But it scraped nothing:
nine store-name lookups ran first and consumed the whole per-minute budget, so
every merchant search afterwards found the queue too deep and was skipped. The
limiter turned a crash into an orderly total skip, which is better and still not
useful. The cause is cheap discovery work starving the expensive work that
actually produces coupons, and the fix is to bound the lookups and give each
merchant its own scheduled step rather than one long action holding them all.

So two things remained unproven rather than proven at that point: per-metro
rescraping in a second city, and price repair against live extracted data.

Fixing that meant changing the shape of a run. It had been one action holding
everything — plan, then every merchant, then match — which could not survive the
limiter: discovery spends the per-minute budget first, and each merchant
afterwards was either asleep inside an action with a finite budget or refused
outright. A run is now a chain of scheduled steps, one merchant per step, so each
step is short, the rolling window drains between them, and a merchant the limiter
turns away is rescheduled with a backoff rather than abandoned. Two smaller
causes went with it: a city plan was resolving an unbounded number of store names
and spending the whole budget on discovery before any merchant was read, and it
was doing that partly on sites that are not shops — a newspaper had been stored
as a grocery merchant. Category and tag pages now count as roundups too, after a
recipe search paid to scrape a category index twice and found no ingredients in
it either time.

A clean-slate San Diego run then proved what the previous one could not. The same
city that had skipped all nine of its stores scraped five and skipped two, with
no error. Kroger, still fresh for Cleveland, was correctly scraped again for San
Diego and recorded under its own metro — which is the per-metro freshness rule
working rather than being asserted. Every price in the forty coupons it stored is
decimal-correct, against the flattened ones this started with. Discovery cost six
site lookups where the previous attempt spent twenty-two.

It attached no deals, and that is the honest result rather than a failure. The
overlap between what the recipes needed — olive oil, tahini, kalamata, hummus —
and what San Diego is discounting this week — bacon, franks, gnocchi, lasagna,
cake — is a single bad match, which the selection step correctly refused. The
matching worked; there was nothing to find.

It surfaced two more problems. The second of them is now fixed: a job sat in the
deals step past the stalled threshold, because the chain is deliberately slow and
nothing touched the job's timestamp while it ran, so the screen would have told
someone a working run had stopped responding — which it did, for half an hour,
during the San Diego run. Every stretch that used to go quiet now reports where
it is: planning before it starts, each merchant as it is reached, a merchant
waiting on the limiter, and the final matching call. The status text is the point
as much as the timestamp, so "Checking kroger.com (2 of 5)" replaces a static
line that never changed. The heartbeat writes only the detail, never the status,
so it cannot knock a job out of the step it is in, and a run with no waiting job
— a cron or a prompt — writes nothing at all.

The dog treat is fixed too, by changing the question rather than lengthening the
answer. "Is this food?" had been a boolean plus a denylist of sixty-nine product
names, which is the wrong shape twice over: not-food is unbounded, so the list
could only ever grow after something unwanted had reached a user, and a boolean
is the weakest classification a model can be asked for, because false has to be
actively chosen against a default of omission — which is how an omitted flag came
to mean "keep".

Extraction now returns a department instead, from a fixed list with real
non-grocery homes in it, so a crockpot has somewhere correct to go rather than
being forced into a food aisle. Three signals decide, in order: a category word
settles it, which is what a backstop is for; then a known department; and
anything the extractor genuinely could not place has to be recognised by the
food vocabulary. The hand-written list is down from sixty-nine product names to
twenty-one category words — a dog treat and a dog bed are both "dog".

The vocabulary itself is derived rather than written, composed from the
department keywords and allergen terms this project already maintains for the
shopping list and the safety filter, so adding a department keyword widens it for
free. That floor is genuinely insufficient and there is a test saying so:
gnocchi, samosa, watermelon and flan are all absent from it, and all four are
real food from a live coupon pool. So it learns. Every recipe the product parses
contributes its ingredients, recorded where every recipe already passes through,
bounded at forty new words per recipe and three thousand on read. Reading one
gnocchi recipe teaches gnocchi and halloumi, and the coupon filter recognises
them from then on.

Not yet confirmed against the live extractor: no run has produced a department
field, only the boolean it replaces. Tests are at 181.

### 2026-09-15 - 06a7851
Restyled every screen to the "soft modern" redesign: a near-white ground, mint
panels, dusty teal accents, deep teal buttons, plum type, and the hand-drawn
frigid logo (`app/globals.css`, `public/frigid-logo.png`). Added a shared header
with Kitchen, Ask and Preferences links (`app/components/AppHeader.tsx`). The
landing page gained a hero and a "how it works" row, the code step shows six
digit boxes, onboarding has a segmented progress bar, and the home page shows a
live progress card and the shopping list by department. Dark mode was removed.
No backend changes. Lint and the `app/` type-check pass; the screens have not
yet been checked in a browser past the sign-in gate.

### 2026-09-15 - cccde8a
Fixed the bug that was killing every coupon run, and gave runs a screen to fail
on. The selector's argument validator listed every coupon field except
`primaryItem` (`convex/deals/match.ts`), which the extractor had started setting
and which all 104 stored coupons carry — so Convex refused the call at the
argument boundary and every run died at the final step, after all the scraping
was paid for. One had pulled 74 coupons from three merchants before throwing.
The field is added rather than stripped because `matchIngredients` and
`keepAsFood` both read it (`convex/deals/policy.ts`).

The reason it read as stagnation rather than failure: nothing showed either. A
run row was written exactly twice, at insert and at the end, and the heartbeat
that reports progress wrote only to a recipe job — which a run started from the
prompt or the cron does not have, so all six calls were no-ops. Runs now carry
`statusDetail` and `updatedAt`, the heartbeat writes the run row whether or not
a recipe job is waiting, and `latestRun` derives `stalled` from that clock the
way recipe jobs already do, falling back to the start time for rows written
before the field existed (`convex/schema.ts`, `convex/deals/run.ts`,
`convex/deals/data.ts`, `convex/deals.ts`).

`latestRun` had been exported since the pipeline landed with no callers at all.
A shared `DealsRunCard` now reads it on both screens: full width on the ask
screen, replacing a modal that said "your results are on the way" whatever
happened, and compact in the home page's "this week's picks" slot, which keeps
its honest "coming next" copy until there is a run to report. Zero matches
renders as a real answer rather than a failure, because it is one. Built from
the tokens the redesign already ships; one indeterminate progress bar rather
than the recipe card's segmented one, since a run is however many stores its
city turns out to have.

Verified: 185 tests pass, up from 181 — the four new ones cover the validator
against a real stored coupon, a run reporting its own progress with no recipe
job, and the stall derivation including the missing-clock fallback. The selector
was called against the live deployment with real coupons and returned picks with
reasons, which is the exact call that had been throwing.

The same commit fixes why a politely worded request found the wrong food. The
search query kept the first ten words of the prompt and stripped stopwords only
later, so "give me some recipes to help me use up my tomatoes" spent its whole
allowance on filler and dropped the eleventh word — the only one naming a food.
A profile term was then appended where the subject had been, and the search went
out as "...use up my easy", returning weeknight roundups. Stopwords now go
before the cap and the cap is twenty, reusing the stopword set already in the
file (`convex/recipeText.ts`). Tests are at 187.

A full run then went green end to end: that prompt returned four recipes and a
fifteen-item shopping list, and the email was sent. Two things the run exposed.
No deals were attached, because the city's stored coupons had nothing for a
tomato list — which means the selector fix above is still proven only by direct
call and by test, not by a complete run. And the roundup filter caught none of
the seven roundups the first search returned: it anchors "-recipes" and
"-ideas" at the end of a path, so "/40-easy-dinner-recipes-for-busy-weeknights/"
and "/gallery/easy-vacation-meals" both passed, costing five credits to scrape
pages with no ingredient list (`convex/recipeCatalog.ts`).

The sharpest thing found today is unfixed. Convex actions run at most once, and
a step that dies transiently — a restart, a deploy, a dropped connection — leaves
its job in an active status with nothing to clear it. That happened to a live
job here. Every active status blocks the one-at-a-time guard, so the user is
locked out of searching again, permanently: the stalled flag is derived at read
time for display and no cron reaps the row. Recovery took invoking the step by
hand.

### 2026-09-18 - working tree
Cut the Ask screen. The kitchen panel's recipe search is now the only place a
prompt goes in: `app/prompt/page.tsx` and `app/components/PromptConsole.tsx` are
deleted and the nav is Kitchen and Preferences (`app/components/AppHeader.tsx`).

Deals already reached that email — `attachDeals` matches stored coupons against
the job's own shopping list and `recipeEmail.ts` renders an "on sale for this
list" section in both bodies (`convex/recipeRun.ts`, `convex/recipeEmail.ts`).
Removing Ask helps it rather than replacing it: a manual run spent the shared
cooldown that the recipe step needs before it may scrape a cold city, so asking
first could leave the next kitchen email with no deals in it.

What was missing was proof. The seam tests stopped where the coupons landed on
the job row, so the renderer — the one part that decides whether a deal reaches
the inbox — had no coverage at all. `tests/recipeEmail.test.ts` covers deals in
the text and HTML bodies, the absent and empty cases printing no heading, and
scraped coupon text being escaped with non-http source URLs dropped. Suite is at
195, up from 187. The tests were checked against a deliberately broken renderer
first: disabling the deals section fails five of the eight, and the three that
do not touch deals still pass.

Then took the dead code out rather than leaving it. Coupon discovery now has
one public function, `latestRun`, and no public way to start a run at all:
`requestRun` was the Ask screen's backend and `findForIngredients` never had a
caller, so both are gone (`convex/deals.ts`, 180 lines to 69). Runs begin in
exactly two places, neither reachable from a client — the recipe pipeline's
deals step and the daily cron. A run is the most expensive thing this product
does, so that is a smaller surface worth having. `DealsRunCard` lost its
unreachable full-size variant and the prop that selected it, keeping the one
card the home page renders (172 lines to 106).

The guard those mutations wrapped is still the thing that costs money when it is
wrong, so its tests now drive it directly instead of through a deleted caller:
the cooldown, the row being written before it can be read, the cooldown expiring,
and the shared daily ledger, all against `deals.data.runBlocked` — whose only
caller left is the recipe step (`tests/deals.test.ts`). The one test that went
away with its subject checked an empty ingredient list, which was
`findForIngredients`-only validation.

Verified: 194 tests pass, lint and TypeScript are clean, and `next build`
succeeds with `/prompt` absent from the route manifest and no reference to the
deleted component or its href anywhere in the built bundles. Against the local
backend, `deals:latestRun` answers and `deals:requestRun` returns "Could not
find function"; the deployment's function list shows `deals.js:latestRun` public
and every other deals function internal.

Then ran it for real, twice, against the local backend — the first live proof
this feature has ever had. The first run returned four chicken recipes and a
nineteen-item list, emailed, and attached no deals at all. Not the bug it looked
like: the pool was warm, sixty-five coupons for the right stores in the right
city, and the match was honestly empty. The pool was a Trader Joe's seasonal
aisle — pumpkin gnocchi, Jaffa cakes, sweet tea — and the list was raw chicken
and spices. The near-miss says the rule is working: "Chicken Lasagna Florentine"
carries `chicken` in its itemTerms but `lasagna` as its primaryItem, and
matchIngredients keys on primaryItem, which is the guard that stopped "cheddar"
returning a box of Goldfish. Eleven credits, no LLM calls, all JSON-LD.

Correct, and a disappointing inbox — so the kitchen prompt now runs the coupon
search itself, behind the recipe email rather than instead of it. The warm path
used to match from stored coupons and stop, never scraping; it now schedules a
real run once the recipes are away (`searchForDeals` in `convex/recipeRun.ts`).
Profile-wide on purpose rather than narrowed to the shopping list, since
re-applying the filter that just came back empty would reliably send nothing.
Fire-and-forget, so it cannot delay or fail the recipes, and it answers to the
same `runBlocked` guard as every other run, so it cannot outspend the cooldown
or the daily budget.

The second run proved both halves. Two recipes, thirteen items, and a populated
"on sale for this list" in the recipe email — olive oil and chicken broth, both
Aldi. Behind it the follow-up search read five Cleveland stores, found 48
coupons, matched 12 and mailed them as a digest, which is the first coupon email
this project has sent from a prompt. The city's pool went from 65 coupons to 88,
so the next search starts warmer. Cost for the day: 60 deals credits and 22
recipe credits.

Tests are at 196. The one test asserting the warm path "never starts a run" was
rewritten rather than deleted, since that is exactly the behaviour that changed,
and two were added: the follow-up fires with trigger `recipe-after`, and the
guard refuses it inside a cooldown.

Still open. The rate limiter turned away five of the ten merchants it wanted
(`heinens.com`, `davesmarkets.com` and three others), so that run is recorded as
partial rather than as full coverage of the city. Nothing here is committed, and
none of it has run against the production deployment.
