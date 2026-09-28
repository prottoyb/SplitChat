# SplitChat-Dev rehearsal and verification tools

Everything here targets **SplitChat-Dev only**: `dev.mjs` refuses the
production project (and requires the Dev sentinel schema), and browser-based
tools block every request outside `localhost` and SplitChat-Dev.
Production operations use `scripts/ops/prod.mjs`, run by the operator.

## Current checks (run against the current schema)

| Tool | What it proves |
|---|---|
| `api-security-audit.mjs` | anon / outsider / former-member reads, direct writes, RPCs and Realtime across every table (162 checks) |
| `api-chat.mjs` | group chat through the real APIs incl. Realtime isolation (25) |
| `api-smart-expense.mjs` | proposals, approval through the canonical path, Realtime (23) |
| `api-settlements.mjs` | server balances and settlements (19) |
| `api-activity.mjs` | the activity event log (11) |
| `render-review.mjs <dir> [--routes f]` | screenshots at 1440 / 900 / 390 with seeded data |
| `../e2e/e2e.mjs` (`npm run test:e2e`) | 20 critical user journeys in real Chrome |
| `../e2e/a11y.mjs` (`npm run test:a11y`) | rendered WCAG AA-oriented audit |
| `browser-guard-selftest.mjs` | the browser guard itself: a WebSocket or request outside the allowlist, or any URL with the production ref, is a violation; allowed traffic is not (needs only Chrome; contacts no project) |
| `dev.mjs readonly ../../supabase/ops/security_audit.sql` | catalog security audit (every check 0 rows) |
| `compare-dumps.mjs`, `dev.mjs dump` | Dev schema identical to the harness |

## Historical (kept as Phase 1 evidence; do not run against the current schema)

| Tool | Why historical |
|---|---|
| `api.mjs`, `api-batch2.mjs` | call the legacy numeric expense RPC dropped by M14; they refuse to run unless `--historical-pre-m14` is passed, e.g. when replaying production's path from a reset Dev |
| `api-batch3.mjs`, `api-ca2.mjs`, `api-race.mjs` | batch 3 approval evidence; `api-batch3.mjs verify3b` checks that the legacy RPC is gone |
