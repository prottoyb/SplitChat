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
| Sub-phase | **M11–M15 implemented and dress-rehearsed on SplitChat-Dev (approved scope); in review.** CA-2 proven through real GoTrue (26/26, re-run on the final trigger). See "In progress" |
| Branch | `feature/phase1-db-hardening`. Backup pushes to origin are allowed for this branch only: no force push, no PR, no merge, no tags |
| Last verified checkpoint | see `git log -1` on the branch; setup checkpoint follows CP0 `7bd8557` |
| Next human gate | **Production Batch 3 execution approval** (3a, then 3b), after review sign-off and the approval report. No production operation without it |

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

- **Batch 3 implemented, dress-rehearsed on SplitChat-Dev, round-1 reviewed; not yet pushed.** Commits: M12 `a5ed4e8`, M13 `7636d08`, M15 `d023871`, M14 + ops `9774a8c`, then the QS-B3-1 fix and docs (see `git log`).
  - Batch 3a = M11, M12, M13, M15, `20260927135000` (QS-B3-1 fix); batch 3b = M14 (frontend attestation >= `a5ed4e8`). `scripts/ops/prod.mjs` holds both manifests.
  - Evidence: `docs/phase1/batch3-rehearsal.md` (3a/3b VERIFY PASSED on dev, API 36/36 and 28/28, CA-2 re-run 26/26 on the final trigger). SplitChat-Dev is now at the full batch-3 schema (17 versions).
  - Reviews: round 1 QA/Security PASS (QS-B3-1 MEDIUM fixed), Senior APPROVE WITH CONDITIONS (docs); round 2 QA/Security PASS (QS-B3-2 LOW fixed: lock before counted attempt), Senior APPROVE. Final: QA/Security CONFIRMED (no open findings), Senior APPROVE. **Stopped at the Production Batch 3 approval gate:** report `docs/phase1/batch3-approval-report.md` (3a then 3b, separate execution approvals). Branch backed up to origin.
  - **2026-09-27:** operator accepted batch 3 for final rehearsal (attestation `no-live-frontend`), approved a dev-only reset, and approved the read-only production 3a preflight + dry-run only (no write). Clean rehearsal from M0–M10 on SplitChat-Dev PASSED for 3a and 3b (`docs/phase1/batch3-rehearsal.md`, last section); dev is now at the full batch-3 schema again. **Waiting for:** the operator to run the production 3a preflight/dry-run (DB_URL exists only in the operator's shell), then the final Batch 3a write-approval request. **No production write is approved.**
  - No edit UI in Phase 1 (`update_equal_split_expense` is RPC-only, tested).
- Historical rehearsal scripts `api.mjs` and `api-batch2.mjs` call the legacy RPC; they target pre-M12 schemas and are superseded by `api-batch3.mjs`.

## Next steps (design §E)

1. Wait for operator approval of the M11+ scope. Then implement locally, rehearse on SplitChat-Dev, review, and propose batch 3. Production M7/M8 are now fix-forward only after any leave/remove activity.
2. While waiting (or after), continue M6–M10 locally. M11 needs a
   SplitChat-Dev GoTrue-deletion proof of its trigger.

## How to run

- `npm run test:db` runs every case. Add `-- --case 030` for one case, `-- --keep` to keep the cluster, or `-- --export-dump <file>` to write the expected post-migration schema.
- Rehearsal: `node scripts/rehearsal/dev.mjs <init|check|sql|file|readonly|dump|cli ...>`, `node scripts/rehearsal/api.mjs <seed|verify>`, and `node scripts/rehearsal/compare-dumps.mjs <expected> <actual>`.
- Needs PostgreSQL 17 binaries (default Windows path, or set
  `SPLITCHAT_PG_BIN`).

## Validation status

At the batch 3 review-fix checkpoint (2026-09-26): lint ✅, build ✅, test ✅ 190/190, npm audit ✅ 0, **test:db ✅ round-trip, 16 rollback checks (M11 up/down only: fix-forward), 23/23 cases, 440 assertions**; **SplitChat-Dev batch 3 ✅** (3a VERIFY 23/23 + API 36/36; 3b preflight PASS, VERIFY; fix: VERIFY 24/24, CA-2 26/26, API 28/28).

Batch 2 checkpoint (production, `f32b56d`): SplitChat-Dev pre-flight 6/6, VERIFY 22/22, API 44/44.

## Unresolved risks

- **Production after batch 2 (2026-09-26):** QS-1–QS-6 and QS-9 are closed; the anonymous and signed-in membership oracles are gone; least privilege is in place; membership history is soft, with one owner per group. Remaining items and the migration that closes each:
  - owner learns that an email exists only when that account is added (by design);
  - the expenses FK still CASCADEs from groups, though no client can delete groups any more (M11 makes it RESTRICT);
  - remainder-cent order mismatch (M12);
  - owner account deletion refused with an Auth 500 until M11.
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

`src/pages/ActivityPage.tsx`, `AuthPage.tsx` and `DashboardPage.tsx` had line-ending-only differences. Since a `git add src` on 2026-09-26 refreshed the index, they no longer show as modified. Their working-tree bytes are unchanged and they were never committed.
