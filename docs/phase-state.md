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
| Roadmap phase | **Phase 9 (Product Experience, UX & Functional Refinement) — STARTED 2026-09-29** (operator approval; scope and decision boundary: `docs/phase9/scope.md`; plan: `docs/phase9/plan.md`). First deliverable is the UX/product review and a prioritised proposal only; stop and present major product/IA decisions before implementation. Earlier: Phase 8 **COMPLETE** (`docs/phase8/plan.md`), merged to `main` via PR #1 (merge commit `dfec625`); Phases 2–7 **COMPLETE** (see their plans and ADR-0008…0012) |
| Production | **At M23: 25 migration versions** (Phase 1 state + batch 4 M16–M23). Batch 4 executed by the operator and verified (operator report, 2026-09-29): 25 versions, post-checks 13/13, ledger unchanged, schema matched the reviewed post-batch-4 schema, security audit passed. **Frontend not deployed** (hosting undecided, G5). Phase 9 makes no production writes or deploys; new backend work uses new migrations rehearsed on SplitChat-Dev and needs separate approval for production |
| Branch | **`feature/phase9-product-ux`** from `main` @ `dfec625` (base verified equal to `origin/main` before branching). Backup pushes of this branch allowed; no force push; `main` pushes are the operator's (git-guard). Earlier phase branches are merged history |
| Last verified checkpoint | `main` @ `dfec625` (Phase 8 merged; Phase 8 validation below) |
| Next human gate | Presentation of the Phase 9 prioritised proposal (major product/IA decisions), or any item on the Phase 9 "stop for human approval" list (`docs/phase9/scope.md`): new core financial concept, balance/settlement semantics, ownership/permissions, role model, external service, paid infrastructure, significant backend architecture change, migration changing production data semantics, destructive behaviour, any production write, deployment |

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

- Design: `docs/phase1/design.md` (approved; "Operator decisions", "Review resolutions" and the batch 3 review record take precedence) and ADR-0001…0007 (Accepted).
- G1: members browse active members only; historical names via `get_ledger_identities(group)` (ledger-referenced users, display name only).
- G2: no Admin role; roles are Owner and Member.
- G3: Supabase CLI pinned `supabase@2.117.0` (devDependency), no Docker, `--db-url` only. The CLI's output depends on agent detection: every tool call pins `--agent no`, and `migration list` is read with `--output-format json` through a strict parser (`scripts/ops/cliOutput.mjs`).
- G4: SplitChat-Dev ref `opviwtyfssxoheigflxw` (free tier). Production ref `jhftlnsccurhfgneltgi`, never targeted by rehearsal tooling. Dev secrets only in git-ignored `.env.splitchat-dev.local`. Deleting SplitChat-Dev needs human approval (an in-place reset was approved once, 2026-09-27: `scripts/rehearsal/reset-dev-to-empty.sql`).
- G5: hosting undecided; **no live frontend** (operator attestation `no-live-frontend` for batches 2, 3a, 3b). Any future deployment must be built from a commit containing `a5ed4e8` (the v2 / integer-cents frontend).
- Production operations are run by the operator in their own PowerShell (`DB_URL` never enters Claude's shell) with `scripts/ops/prod.mjs --batch <id>`; the team prepares the reviewed evidence, commands and reports.
- The Phase 1 index cleanup (then numbered M16) is deferred to Phase 8; M16 is now the activity event log.
- Tests: Tier 1 local PG17 + shim (`npm run test:db`, DS-8 guard); Tier 2 SplitChat-Dev; production is never used for tests.

## Completed (Phase 1)

| Batch | Migrations | Production | Evidence |
|---|---|---|---|
| Setup | harness, shim, M0 baseline (exact round-trip), characterisation cases | — | CP0–CP2 |
| 1 | M0 history repair + M1–M5 (immutable expense identity, anon/definer hardening, no direct ledger writes, ledger invariants, owner-cascade interim) | applied + verified (`7fa607e`) | `docs/phase1/batch1-rehearsal.md` |
| 2 | M6–M10 (least privilege, soft membership history + single owner, private helpers / active-member RLS / ledger identities, membership RPCs, no direct membership deletes) | applied + verified (`f32b56d`) | `docs/phase1/batch2-rehearsal.md` |
| 3a | M11 ledger-preserving account deletion, M12 integer cents + canonical split + v2, M13 expense edit/delete, M15 solo-group deletion, `20260927135000` owner-deletion/add-member serialisation | applied + verified 2026-09-27 (from `25b7deb`) | `docs/phase1/batch3-rehearsal.md`, `batch3-approval-report.md` |
| 3b | M14 drop legacy numeric expense RPC | applied + verified 2026-09-27 (from `43e02ed`) | same, `batch3b-approval-report.md` |

Batch 3 was rehearsed twice on SplitChat-Dev, the second time from a clean reset replaying production's full path (M0 identical to the Phase 0 capture → batch 1 → batch 2 → 3a → 3b), with CA-2 26/26 and the race proof 6/6 through real Supabase Auth/PostgREST.

## Next steps

0. **Phase 9: increments 0–4 implemented and reviewed on `feature/phase9-product-ux`** (`docs/phase9/plan.md` has the review records). Delivered: tokens and design system; phone shell; 4 group tabs and a group menu; Overview next step; dashboard "Needs you" and Overall; open-proposal strip and Chat badge; flow polish; owner rename (M24) and name rules (M25) with ADR-0013; profile page, change password and reset password. Reviews: designer PASS WITH CHANGES (fixed), Senior APPROVE (slice) and APPROVE WITH CHANGES (increments 1–4; MEDIUM accepted with a follow-up), QA/Security FAIL → CRITICAL fixed → PASS. **SplitChat-Dev at 27 versions (M24, M25 rehearsed); production untouched at 25; not deployed.** Final designer pass done (PASS WITH CHANGES, fixed; `bae5380`). **Phase 9 completion report delivered 2026-09-29: waiting for the operator** to decide on Phase 9 acceptance, the PR/merge to `main`, the production release of M24/M25 and Auth config (separate approvals), and starting Phase 10. **Production prerequisites for a later release:** apply M24/M25 (separate approval); Auth redirect URL `<site>/reset-password` and email delivery; confirm "Secure password change" is enabled; a read-only count of live profiles breaking M25 before any VALIDATE.
- (historical) **Phase 8 complete; batch 4 dress rehearsal complete — wait for the operator.** Dress rehearsal (2026-09-29): Dev reset in place → production's path replayed with `prod.mjs --rehearse-on-dev` (batches 1, 2, 3a, 3b) → batch 4 identify, preflight, dry-run, four push refusals, push, re-push refused, verify 13/13, audit 12/12, post-push preflight refuses → migrated-state suites all green. Its tooling fixes (reset script covers batch 4 tables; complete backfill info rows) reviewed: QA/Security PASS, Senior APPROVE. SplitChat-Dev is now at the post-batch-4 state (25 versions) with fresh synthetic data. Operator decisions pending: open the PR / merge to `main`, batch 4 execution (runbook), frontend deployment (hosting undecided, G5), Phase 9. Do not start any of them without approval. SplitChat-Dev at 25 versions. Production backlog, in order: M16 `20260928100000`, M17 `20260928110000`, M18 `20260928120000`, M19 `20260929100000`, M20 `20260929110000`, M21 `20260930100000`, M22 `20260930110000`, M23 `20260930120000` (`docs/phase8/release-batch4.md`). Items 1–3 below are historical (pre-Phase 8).
1. **Wait for the operator.** Next: operator decisions from the end-of-programme report (product confirmations in ADR-0011/0012 status lines; the production release batch M16→M20; Phase 8 approval). Do not start Phase 8 without approval. Earlier: Phase 7 (Smart Expense; ADR-0012 to write, sketch in the architect's ADR-0011 hand-off: candidates table keyed by message id, approve RPC over a shared private expense-creation core). **Operator confirmation to record in the end-of-programme report:** chat messages are permanent and survive account deletion (ADR-0011 status). Reusable findings:
   - **`.env.local` points at the PRODUCTION Supabase project.** `npm run dev` with default env talks to production. Any rendered review / screenshots must run Vite with `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` overridden to SplitChat-Dev (process env beats `.env*` files in Vite; values from `.env.splitchat-dev.local` via `loadDevTarget`) and must block any request to `jhftlnsccurhfgneltgi` (fail closed).
   - Rendered review: `node scripts/rehearsal/render-review.mjs <out-dir> [--routes file.json]` (SplitChat-Dev only; seeds synthetic users/groups; screenshots desktop 1440 / tablet 900 / mobile 390; browser requests restricted to localhost + Dev, anything else fails the run). Put output in the session scratchpad, never the repo; the designer agent Reads the PNGs.
   - Placement: ADR-0008 says cross-feature composition such as the group workspace lives in `src/app/` (features may import only earlier features in `FEATURE_ORDER`, enforced by `scripts/architecture.test.mjs`; `app/` is unrestricted). Section pages reuse existing feature components/APIs; no client-side balance logic (the header position comes from `get_group_balances`).
   - Git-guard matches command *text*: a Bash command containing a push-to-canonical string (even inside a heredoc or doc edit) is blocked whole. Edit docs with the Edit tool.
2. Production backlog for the next release batch, in order: M16 `20260928100000_activity_event_log`, M17 `20260928110000_settlements` (both rehearsed on SplitChat-Dev). No production write without its own approval.
3. SplitChat-Dev is at 22 versions (batch 3 + M16 + M17 + M18 + M19 + M20). Production backlog now also includes M18 `20260928120000_group_messages` M19 `20260929100000_smart_expense_candidates` and M20 `20260929110000_expense_core_membership_locks` (in that order after M17; pre-check the `supabase_realtime` publication before/after, ADR-0011 condition 14 / ADR-0012 condition 16).
4. The canonical branch and its remote copy are both at `02d6d64` (Phase 1 merge, pushed by the operator 2026-09-28). The repository is public (github.com/prottoyb/SplitChat); the local repo and this file stay authoritative.

## How to run

- `npm run lint`, `npm run build`, `npm test` (Vitest: `src/**` and `scripts/**/*.test.mjs`), `npm run test:db` (add `-- --case 030`, `-- --keep`, `-- --export-dump <file>`, `-- --export-dump-at <version> <file>`).
- Rehearsal (SplitChat-Dev only): `node scripts/rehearsal/dev.mjs <check|sql|file|readonly|dump|cli ...>`, `api.mjs`, `api-batch2.mjs`, `api-batch3.mjs <prepare|verify3a|verify3b>`, `api-ca2.mjs`, `api-race.mjs`, `compare-dumps.mjs`; the production tool itself with `--rehearse-on-dev`.
- Needs PostgreSQL 17 binaries (default Windows path, or `SPLITCHAT_PG_BIN`).

## Batch 4 dress rehearsal (2026-09-29)

Clean reset → batches 1–3b replayed via the production tool (all VERIFY PASSED; API 44/44, 36/36, 28/28) → batch 4: PREFLIGHT PASSED (17 versions, Q20–Q22 = 0), dry-run M16–M23, 4 refusals, push, re-push refused, **VERIFY PASSED 13/13** (25 versions, schema exact, ledger unchanged), **AUDIT PASSED 12/12** → invariants 11/11 = 0 · security 162/162 (×2) · activity 11/11 · settlements 19/19 · chat 25/25 · Smart Expense 23/23 · race 6/6 · CA-2 26/26 · E2E 20/20 · a11y 0 findings.

## Validation status (Phase 8 completion, 2026-09-29)

lint ✅ · build ✅ · Vitest ✅ **547/547** (39 files) · npm audit ✅ 0 · **test:db ✅ 35/35 (777)** incl. the catalog security audit (12 checks, 0 rows) · E2E ✅ **20/20** on SplitChat-Dev (no request or socket outside localhost/Dev) · a11y ✅ 24 page views, **0 findings** (stricter final rules) · browser guard self-test ✅ 7/7 · SplitChat-Dev (25 versions): security audit 162/162, chat 25/25, Smart Expense 23/23, settlements 19/19, activity 11/11, production tool rehearsal verify/audit PASSED (unchanged since `1dd1dfc`).

## Validation status (Phase 7 completion, 2026-09-29)

lint ✅ · build ✅ · Vitest ✅ **525/525** (36 files) · npm audit ✅ 0 · **test:db ✅ 31/31 (737)** · SplitChat-Dev (22 versions): M19 and M20 schemas IDENTICAL to the harness; `api-smart-expense` 23/23, `api-chat` 25/25, `api-settlements` 19/19, `api-activity` 11/11 · rendered review ✅.

## Validation status (Phase 6 completion, 2026-09-28)

lint ✅ · build ✅ · Vitest ✅ **439/439** (33 files) · npm audit ✅ 0 · **test:db ✅ 28/28 (629)** · SplitChat-Dev M18: schema IDENTICAL, `api-chat.mjs` 25/25 · rendered review ✅.

## Validation status (Phase 5 completion, 2026-09-28)

lint ✅ · build ✅ · Vitest ✅ **398/398** (30 files) · npm audit ✅ 0 · **test:db ✅ 26/26 cases, 564 assertions** (no database change in Phase 5) · rendered review on SplitChat-Dev ✅ (36 screenshots + targeted re-renders; no request outside localhost/Dev).

## Validation status (Phase 1 completion, 2026-09-27)

lint ✅ · build ✅ (known >500 kB chunk warning) · Vitest ✅ **214/214** (13 files) · npm audit ✅ 0 · **test:db ✅** baseline round-trip exact, **16 rollback checks** (M11 up/down only, fix-forward), **23/23 cases, 440 assertions** · production batches 1, 2, 3a, 3b **VERIFY PASSED**.

## Unresolved risks / deferred items

- **M11 is fix-forward only** in production (account deletions tombstone profiles; `profiles_id_fkey` cannot return). Its `auth.users` trigger cannot be dropped with `DROP TRIGGER` by `postgres`, but is removed as a dependent object by `DROP FUNCTION private.handle_auth_user_deleting() CASCADE` — an emergency path only, never a reviewed rollback.
- GoTrue soft delete would bypass the deletion trigger; hard delete is the supported path.
- Orphaned groups (sole owner deleted their account) have zero active members and no cleanup/export path (DS-3).
- Expense and solo-group deletions are permanent; they are recorded in the activity log (M16, live in production since batch 4).
- CI workflow exists (`.github/workflows/ci.yml`) but has not run on a PR yet; hosting undecided (G5).
- Accepted by design: add-by-email reveals an account only when it is added; membership RPC timing side channels (DS-10); `supabase_admin` default privileges not changeable by `postgres`.
- Three-way concurrency (deletion + transfer + add) reasoned, not tested.
- Frontend follow-ups from Phase 0 (Phase 2 scope): component tests, >500 kB chunk, stale data on route change, date validation, error wording; `api.mjs`/`api-batch2.mjs` still call the dropped legacy RPC (historical tools).
- The Phase 1 index-cleanup migration (originally numbered M16; that number is now the activity event log) is deferred to Phase 8.

## Working-tree notes

`src/pages/ActivityPage.tsx`, `AuthPage.tsx` and `DashboardPage.tsx` had line-ending-only differences. Since a `git add src` on 2026-09-26 refreshed the index, they no longer show as modified. Their working-tree bytes are unchanged and they were never committed.
