# CI and verification

## GitHub Actions (`.github/workflows/ci.yml`)

Runs on every push, every pull request and on demand. No secrets, no
Supabase access, no paid infrastructure (GitHub-hosted Ubuntu runners).

| Job (required check name) | What it runs |
|---|---|
| **Lint, build, test, audit** | `npm ci`, `npm run lint`, `npm run build` (`tsc -b` + Vite), `npm test` (Vitest incl. the ADR-0008 architecture test), `npm audit` (any severity fails) |
| **Database harness (PostgreSQL 17)** | installs PostgreSQL 17 (PGDG) and runs `npm run test:db`: a throwaway loopback cluster, the Phase 0 baseline round-trip, every migration's rollback up/down/up, and every `tests/db/cases/*.sql` (incl. real concurrent sessions via dblink) |

Make both **required status checks** on `main` (repository settings, branch
protection) — an operator action. Job logs need admin rights to read; a
failing database job also publishes its failure lines as a public
annotation.

History: until `494cf0d` (Phase 8) the database job had failed on every run
(the packaged Unix-socket directory is not writable by the runner user); it
has passed since.

## Before sign-off (needs SplitChat-Dev credentials; never production)

Run locally by the team from a machine with `.env.splitchat-dev.local`:

| Command | Purpose |
|---|---|
| `npm run test:e2e` | 20 critical journeys in real Chrome |
| `npm run test:a11y` | rendered WCAG AA-oriented audit (names, keyboard focus, contrast, structure, 44px touch targets on mobile) |
| `node scripts/rehearsal/api-security-audit.mjs` | behavioural security audit (anon / outsider / former member; tables, RPCs, Realtime) |
| `node scripts/rehearsal/dev.mjs readonly supabase/ops/security_audit.sql` | catalog security audit (every check 0 rows) |
| `node scripts/rehearsal/api-{chat,smart-expense,settlements,activity}.mjs` | feature API checks |

These are not in CI because they need SplitChat-Dev secrets and a shared
Dev project. They can move to a manual workflow with repository secrets
later (operator decision: storing Dev credentials in GitHub).
