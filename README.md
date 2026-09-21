# frigid

Ask for something to cook. frigid searches real recipe sites, reads the recipes,
drops anything that clashes with your allergies, merges the rest into one
shopping list by aisle, checks it against this week's coupons at your stores, and
emails you the lot.

Built for the Convex All Gas Hackathon.

```
"a cold night hearty beef stew"

  4 recipes · 15 things to buy · 3 of them on sale at Kroger and Aldi
```

No recipe is generated. Every one is a link, and the ingredients come out of the
page's own `schema.org/Recipe` markup.

## Setup

Needs Node 20+, a Convex account, and keys for Firecrawl, OpenAI and AgentMail.

```sh
npm install
npx convex dev        # creates the deployment and writes .env.local; leave running
```

Secrets live on the Convex deployment, not in `.env.local` — functions read
`process.env` from the deployment, so a key in a local file is invisible to them.

```sh
npx convex env set OPENAI_API_KEY            sk-...
npx convex env set FIRECRAWL_API_KEY         fc-...
npx convex env set AGENTMAIL_API_KEY         ...
npx convex env set AGENTMAIL_INBOX_ID        you@yourdomain.agentmail.to
npx convex env set VERIFICATION_CODE_PEPPER  "$(openssl rand -base64 32)"
```

```sh
npm run dev           # localhost:3000
```

Optional:

| Variable | Default | |
|---|---|---|
| `FIRECRAWL_MODE` | `live` | `fixture` serves every paid Firecrawl call from `convex/fixtures/` |
| `RECIPE_LLM_FALLBACK` | `on` | `off` disables the paid recipe extraction fallback |
| `RECIPE_EXTRACT_MODEL` | `gpt-5.5` | model for that fallback |
| `AGENTMAIL_WEBHOOK_SECRET` | — | needed only for inbound mail |

`VERIFICATION_CODE_PEPPER` peppers both code and session-token hashes. Changing
it signs everyone out.

## How it works

**Sign-in.** No passwords. An emailed six-digit code mints an opaque session
token, stored in `localStorage` because static hosting has no server to set a
cookie. It expires in seven days and the database keeps only
`sha256(token + pepper)`. `AuthGate` gates routes in the browser, but every
Convex function re-resolves the token through `userForToken()` — nothing trusts a
client-supplied email.

**Profile.** 21 questions (`convex/onboardingQuestions.ts`), stored as a
`questionId → answer` record so adding one needs no migration. Allergies are
enforced by a keyword table (`convex/allergens.ts`), never a model.

**Pipeline.** Five scheduled actions in `convex/recipeRun.ts`, each patching the
same `recipeJobs` row. The home screen subscribes to that row, so the progress
bar is the backend's actual state — no workflow engine, no polling.

| | |
|---|---|
| `searching` | one Firecrawl search across 14 hand-verified recipe domains |
| `reading` | up to 5 scrapes to keep 4 recipes, ingredients from JSON-LD |
| `shopping` | dedupe across recipes, group by aisle, add store links |
| `dealing` | match stored coupons against this list |
| `emailing` | AgentMail, with one-click unsubscribe |

`dealing` can't fail the job. A warm coupon pool is a database read and the email
goes straight out; a cold city schedules a coupon run that releases the email
when it lands. Nothing retries — a failed scrape was already billed.

**Coupons.** `convex/deals/` finds merchants for a city, scrapes their offer
pages, and stores each offer with one `primaryItem` saying what it's for.
Everything is keyed by metro, since weekly ads are regional. A daily cron mails
whoever is due.

**Staying free.** Firecrawl gives 1,000 credits a month and 10 requests a minute,
shared by both pipelines. Four caches keyed by URL rather than by user (recipes
90d, pages 30d, searches and store lookups 7d), one credit ledger
(`credits.ts`), one request limiter at 8/min (`firecrawlRate.ts`), and the caps
in `recipePolicy.ts` — 5 searches per user per day, 120 credits per day overall.

## Tests

```sh
npm test
```

Unit tests over the pure modules need nothing running. The rest use `convex-test`
against an in-memory database and open with `// @vitest-environment edge-runtime`.
Nothing calls Firecrawl, OpenAI or AgentMail.

## Deploy

First time:

```sh
npx convex deploy
npx convex env set --prod OPENAI_API_KEY sk-...   # and the other four
```

Then, every time:

```sh
npm run deploy        # live at https://<deployment>.convex.site
```

Don't set `NEXT_PUBLIC_CONVEX_URL` yourself. It's inlined at build time and
`.env.local` holds your *dev* deployment, so a plain build ships a production
site pointed at the dev database. The static-hosting CLI passes the right URL as
`VITE_CONVEX_URL` and `next.config.ts` prefers it. Check with:

```sh
grep -rho "https://[a-z0-9-]*\.convex\.cloud" out/ | sort -u
```

Afterwards, point AgentMail's webhook at
`https://<deployment>.convex.site/agentmail/webhook` and set
`AGENTMAIL_WEBHOOK_SECRET`.

Static export rules out rewrites, redirects, headers, middleware, Server Actions
and `next/image` optimization. The HTTP routes this app needs live in Convex's
router instead.

## Notes

`hackathon.md` is the build log required for submission — public, so no secrets
in it. Run `/hackathon` to append an entry.

Built with Claude Code and the Convex plugin
(`claude plugin install convex@claude-plugins-official --scope user`).

MIT.
