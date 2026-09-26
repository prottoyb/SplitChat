# Phase state — authoritative resume point

## New-session recovery protocol (do this before modifying anything)

1. Read `CLAUDE.md`, `docs/product-vision.md`, `docs/roadmap.md`, and this
   file.
2. Run `git status` and `git log --oneline -15`. Confirm the branch and last
   checkpoint below match Git. If they disagree, stop and resolve that
   first.
3. Read the current phase design (`docs/phase1/design.md`, including
   "Operator decisions" and "Review resolutions", which take precedence)
   and `docs/ADR/`.
4. Continue from **Next steps**. Never assume an earlier conversation is
   available.

No secrets are kept here. The production connection string exists only in
the operator's shell (`DB_URL`), and client config is in `.env.local`
(git-ignored).

## Current

| Field | Value |
|---|---|
| Roadmap phase | **Phase 1 — Database and security foundation** (design approved 2026-09-26) |
| Sub-phase | Preflight #1 done (drift ABORT proven to be a CR artifact and fixed; production byte-identical to Phase 0). QA/Security and Senior both reapprove batch 1 (QA condition: re-run the live preflight before push). **Awaiting operator approval: preflight re-run, then repair-m0 + push** |
| Branch | `feature/phase1-db-hardening`. Backup pushes to origin are allowed for this branch only: no force push, no PR, no merge, no tags |
| Last verified checkpoint | see `git log -1` on the branch; setup checkpoint follows CP0 `7bd8557` |
| Next human gate | **Production batch 1 execution approval.** Operations: prod.mjs preflight → repair-m0 → dry-run → push → verify. Runbook: docs/phase1/batch1-rehearsal.md |

## Operating model (operator, 2026-09-26)

- The team executes the approved phase without per-change approval. That
  covers code, tests, local migrations, local DB testing, refactors in
  scope, review fixes, docs, and local checkpoint commits plus backup
  pushes of this branch.
- **Stop for the human before:**
  - the next roadmap phase, or a material scope or architecture change;
  - a major new dependency;
  - **anything on the production Supabase project** (history repair,
    migrations, data fixes, auth/security config, operator ownership
    release);
  - destructive Git operations, force-pushes, merges, PRs;
  - production deploys;
  - anything with billing;
  - deleting SplitChat-Dev.
- Each production operation or declared batch needs its evidence package
  (design "Operator decisions"), then explicit execution approval.

## Key decisions for continuation

- Design: `docs/phase1/design.md` (approved) and ADR-0001…0007 (Accepted).
- G1: members browse active members only. Historical names come from
  `get_ledger_identities(group)`: ledger-referenced users only, display name
  only.
- G2: no Admin role; roles are Owner and Member.
- G3: Supabase CLI pinned `supabase@2.117.0` (devDependency). No Docker.
  Use `--db-url`.
- G4: **SplitChat-Dev created**: ref `opviwtyfssxoheigflxw` (free tier, ap-northeast-1). Production is ref `jhftlnsccurhfgneltgi`, never targeted by rehearsal tooling. Dev password and keys live only in git-ignored `.env.splitchat-dev.local`; synthetic run state is in `.splitchat-dev-rehearsal.json.local`. Rehearsal tools: `scripts/rehearsal/dev.mjs` (sentinel-verified target) and `api.mjs`. Deleting SplitChat-Dev requires human approval.
- G5: hosting is undecided. M10/M14 are blocked for prod until a compatible
  frontend deployment exists.
- M16 is deferred to Phase 8.
- Tests:
  - Tier 1: a disposable local PG17 cluster plus a Supabase shim, run by
    `npm run test:db`, with the positive-target guard (DS-8).
  - Tier 2: SplitChat-Dev.
  - Production is never used for tests.

## Completed

- Phase 0 baseline `cb2db08` (pushed, on `chore/capture-schema-baseline`).
- CP0 `7bd8557`: Phase 1 design, ADRs, phase-state.
- Setup: `docs/product-vision.md`, `docs/roadmap.md`; design approval and
  G1–G5/M16 decisions recorded in design and ADRs; pinned Supabase CLI
  2.117.0 installed (`migration list/repair`, `db push` support
  `--db-url`); `npm audit` 0 vulnerabilities.

- **CP1+CP2** (one commit; the harness can't run without a migration):
  - `npm run test:db` → `scripts/db-test.mjs`: a throwaway PG17 cluster on
    loopback with the DS-8 positive-target guard (scrubbed env, own
    connection strings, then loopback, port and system-identifier
    assertions before any SQL, plus a spoof self-test).
  - Shim `tests/db/shim/` with a self-test against the prod role
    inventory. Helpers in `tests/db/helpers.sql`; fixture in
    `tests/db/fixtures/seed.sql`.
  - M0 `supabase/migrations/20260926000000_baseline_public_schema.sql`,
    generated verbatim from the dump by reordering blocks (tables before
    SQL functions, so no session settings) plus ACL normalisation for
    platform default privileges.
  - The round-trip is exact: a fresh apply dumps identically to the Phase 0
    capture. A mutation check confirmed it detects ACL drift.
  - Characterisation cases `tests/db/cases/0x0_*.sql` reproduce QS-1…QS-7
    locally. Assertions tagged `KNOWN-BAD[Mx]` are flipped by migration Mx.

- CP1/CP2 reviews: QA/Security PASS; Senior APPROVE WITH CONDITIONS.
  Fixes are in `acd4593` (pushed).
- Runner verifies every migration's rollback: up → down (schema equals the
  previous state, ACL order ignored) → up.
- **M1** `acb0aaa`: expense and split identity columns are immutable for
  every role (QS-1).
- **M2** `be80d69`: anon loses EXECUTE on the oracle and the expense RPC;
  `search_path=''` on all definer functions; clients can't execute trigger
  functions (QS-2/8/10).
- **M3** `0e55f0d`: no direct client writes to expenses/splits; the six
  write policies are dropped (QS-3).
- **M4** `25c313e`: deferred balance check plus a membership guard, as
  SECURITY DEFINER private functions; `split_type='equal'`.
- **M5** `6c552d2`: `groups.created_by` FK is RESTRICT (QS-4, interim).
- `supabase/ops/batch1_prechecks.sql`: read-only aggregate pre-checks
  Q1–Q8 for production batch 1.

## In progress

- M1–M5 reviews: QA/Security PASS, Senior APPROVE WITH CONDITIONS (the condition was a reviewed pre-check script: supabase/ops/batch1_prechecks.sql). No CRITICAL/HIGH.
- **SplitChat-Dev rehearsal of batch 1 is complete; all green.** Evidence: `docs/phase1/batch1-rehearsal.md`.
  - Dev after M0 is identical to the production dump.
  - repair → dry-run → push worked without Docker.
  - The ledger was unchanged by the push.
  - Post-checks 17/17; real-API checks 24/24.
  - Dev after M5 is identical to the harness.
  - CA-2 is proven for trigger creation; GoTrue deletion firing M11's
    trigger is still to be proven when M11 exists.
- Rehearsal reviews, round 1: QA/Security PASS, Senior APPROVE WITH CONDITIONS; no CRITICAL/HIGH. Round-2 fixes are recorded in `docs/phase1/batch1-rehearsal.md`:
  - `scripts/ops/prod.mjs` with preflight (exact drift, empty history, Q-gates, lock check) and verify;
  - approval and SHA-256 manifest guards on writes;
  - PGPASSWORD instead of the password in argv, no shell, `SUPABASE_*` scrubbed;
  - a mid-batch failure rehearsal;
  - reviewed rollbacks proven on real Supabase;
  - a dress rehearsal of prod.mjs on SplitChat-Dev: VERIFY PASSED.
- Convention from M6 onward: `SET LOCAL lock_timeout = '5s';` first in every migration.

## Next steps (design §E)

1. On approval: run the production procedure exactly as in the approval report (SPLITCHAT_PROD_APPROVAL=batch1 only for repair-m0/push), keep the evidence directory, and report. On any ABORT/REFUSING, stop.
2. While waiting (or after), continue M6–M10 locally. M11 needs a
   SplitChat-Dev GoTrue-deletion proof of its trigger.

## How to run

- `npm run test:db` runs every case. Add `-- --case 030` for one case, `-- --keep` to keep the cluster, or `-- --export-dump <file>` to write the expected post-migration schema.
- Rehearsal: `node scripts/rehearsal/dev.mjs <init|check|sql|file|readonly|dump|cli ...>`, `node scripts/rehearsal/api.mjs <seed|verify>`, and `node scripts/rehearsal/compare-dumps.mjs <expected> <actual>`.
- Needs PostgreSQL 17 binaries (default Windows path, or set
  `SPLITCHAT_PG_BIN`).

## Validation status

At the rehearsal checkpoint: lint ✅, build ✅ (known >500 kB chunk warning), test ✅ 84/84, npm audit ✅ 0, **test:db ✅ round-trip, 5 rollback checks, 13/13 cases, 86 assertions**; **SplitChat-Dev ✅** (see `docs/phase1/batch1-rehearsal.md`).

## Unresolved risks

- **Production, all pre-existing and unchanged (nothing live has been
  modified):**
  - CRITICAL QS-1 cross-group expense move;
  - CRITICAL QS-2 anon membership oracle;
  - HIGH QS-3 split-sum bypass;
  - HIGH QS-4 owner-deletion cascade;
  - MEDIUM: blanket grants incl. TRUNCATE, email enumeration,
    remainder-cent order mismatch.
- **Local branch interim (by design, closed in M8):** after M2,
  signed-in users can still call `split_chat_is_group_member(group, user)`,
  which the current RLS policies need. Anonymous access is already
  removed.
- **Project:**
  - no migration history on prod;
  - no CI;
  - CA-2 (triggers on `auth.users` allowed?) unproven;
  - SplitChat-Dev not created yet;
  - prod can't be fixed until a production batch is approved.

## Working-tree notes

`src/pages/ActivityPage.tsx`, `AuthPage.tsx` and `DashboardPage.tsx` show as
modified, but only line endings differ. Never stage, commit or reset them.
