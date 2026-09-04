# frigid
A all in one recipe, ingreident hotspot

Built for the **Convex All Gas Hackathon**, sponsored by OpenAI, Firecrawl, and
AgentMail.

**Status:** email verification, sessions, and onboarding are in. Recipe and
ingredient features are next.

## Development environment

| Piece | Status |
|---|---|
| Agent | Claude Code 2.1.231 |
| Convex integration | Official Convex plugin v1.10.0, user scope |
| Convex MCP server | `plugin:convex:convex` — connected |
| Build log skill | `convex-hackathon-skill`, project-local |
| Frontend target | Convex static hosting (`*.convex.site`) |

## How a visitor moves through the app

| Verified | Onboarded | Lands on |
|---|---|---|
| no | — | `/` — enter an email, get a 6-digit code |
| yes | no | `/onboarding` — the taste-profile questionnaire |
| yes | yes | `/home` |

Verifying a code mints an opaque session token. It is hashed before storage, so
the database never holds anything that can be replayed as a sign-in. Gating is
client-side (`app/components/AuthGate.tsx`) because static hosting has no Node
server at runtime, but every Convex function re-resolves the token server-side
and never trusts a client-supplied email address.

Onboarding answers live in `preferences`, alongside a `promptContext` string
built once at save time. Future recipe features inject that string instead of
re-deriving a profile from twenty answers. The questionnaire and the report are
plain TypeScript (`convex/onboardingQuestions.ts`, `convex/onboardingSummary.ts`)
with no model call, so onboarding costs zero OpenAI tokens.

The Convex plugin ships 18 skills, 2 subagents, 3 hooks, and an MCP server for
live deployment introspection. It is installed at user scope, so it applies to
every project on the machine rather than being vendored into this repo.

The hackathon build log skill is project-local, at
`.claude/skills/convex-hackathon-skill/`:

```text
.claude/skills/convex-hackathon-skill/
├── SKILL.md
└── references/
    └── log-format.md
```

## Getting set up

Anyone cloning this repo needs the Convex plugin installed once:

```sh
claude plugin install convex@claude-plugins-official --scope user
claude plugin details convex@claude-plugins-official
claude mcp list
```

Start your session from this repository root. The build log skill is
project-local, so it only resolves when the session root is this directory.

Verify both are live:

```sh
claude -p "List skill names available to you containing 'convex'"
```

Expect `convex-hackathon-skill` plus the `convex:*` plugin skills.

## Build log

`hackathon.md` at the repository root is the evidence-based build log required
for submission. It is public — no secrets, credentials, or personal data belong
in it.

Run `/hackathon` after meaningful progress to append a dated entry. The skill
reads local repository evidence only; it will not invent history, and it never
commits, deploys, or submits.

## Frontend hosting

This project deploys to `convex.site` via the official Convex Static Hosting
component. Install it when there is an app to host:

```sh
npm install @convex-dev/static-hosting
npx @convex-dev/static-hosting setup
```

Production deploys land at `https://<deployment>.convex.site`.

## Submission

Submit at
<https://vibeapps.dev/judging/convex-all-gas-hackathon-openai/submit>.

Deadline: **September 22, 12:00 PM PT**.

Required:

- [ ] Public source repository
- [ ] `hackathon.md` at the repository root
- [ ] Live `convex.site` URL judges can open without an invite
- [ ] Video no longer than three minutes

## License

MIT. See [LICENSE](LICENSE).

## getting Started
npx convex dev
npm install
npm run dev