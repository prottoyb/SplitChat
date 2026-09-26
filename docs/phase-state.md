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
| Sub-phase | **M11–M15 in progress (approved, local + SplitChat-Dev only).** M11 done (CP13a `f687da8`) and **CA-2 PROVEN** on SplitChat-Dev via real GoTrue (26/26, `scripts/rehearsal/api-ca2.mjs`); M11 is applied on SplitChat-Dev. M12 DB migration + rollback written (WIP commit); **resume at the M12 test updates** (see "In progress") |
| Branch | `feature/phase1-db-hardening`. Backup pushes to origin are allowed for this branch only: no force push, no PR, no merge, no tags |
| Last verified checkpoint | see `git log -1` on the branch; setup checkpoint follows CP0 `7bd8557` |
| Next human gate | **Operator approval of the next Phase 1 scope** (M11+: ledger-preserving account deletion — needs the SplitChat-Dev GoTrue deletion proof, CA-2; M12 cents/canonical split; M13 edit/delete RPCs; M14; M15). No production operation without a new approval |

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

- **Done locally (not reviewed, not pushed):** M12 `a5ed4e8` (CP14), M13 `7636d08` (CP16a), M15 `d023871` (CP16b). test:db 22/22 (432 assertions); lint/build/test 190/190.
  - M12: `equal_split_cents` enforces the canonical rule and its error codes; legacy wrapper routes invalid amounts through v2 (auth first, no overflow). Shared vectors `src/lib/fixtures/equal-split-vectors.json` (runner -> `tests.split_vectors`; Vitest). Cases 180 (v2) and 181 (M12 on a populated ledger rewrites nothing). Frontend uses v2 + integer cents.
  - M13: `update_equal_split_expense` / `delete_expense` (case 190). Client write path is `src/lib/expenseApi.ts`; ExpenseDetailsPage has a confirmed delete. **No edit UI in Phase 1** (RPC only).
  - M15: `delete_group` per the approved rule (case 200): refused if anyone else ever had a membership row (`group_has_other_members`) or any record refers to another user (`group_has_shared_history`); `member_add_attempts` kept (rate-limit reset guard). GroupDetailsPage offers delete to a sole active owner.
- **Next:** M14 (`20260927140000_drop_legacy_expense_rpc`) + frontend attestation for batch 3; then batch 3 ops artifacts, SplitChat-Dev rehearsal (dev is at M11), api-batch3, reviews, Batch 3 report.
- Historical rehearsal scripts (`api.mjs`, `api-batch2.mjs`, `api-ca2.mjs`) call the legacy RPC; they target pre-M12 schemas and are not runtime dependencies.

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

At the batch 2 re-rehearsal checkpoint: lint ✅, build ✅, test ✅ 117/117, npm audit ✅ 0, **test:db ✅ round-trip, 10 rollback checks, 17/17 cases, 180 assertions**; **SplitChat-Dev batch 2 ✅** (pre-flight 6/6, VERIFY 22/22, API 44/44).

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
