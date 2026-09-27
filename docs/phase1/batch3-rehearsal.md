# Production batch 3 — SplitChat-Dev rehearsal (2026-09-26)

Target: SplitChat-Dev `opviwtyfssxoheigflxw` only (ref guard + sentinel).
Production was not contacted. Tools: `scripts/ops/prod.mjs --rehearse-on-dev`,
`scripts/rehearsal/dev.mjs`, `scripts/rehearsal/api-batch3.mjs`,
`scripts/rehearsal/api-ca2.mjs` (M11, earlier).

## Batch structure

| Step | Migrations | Why separate | Frontend attestation |
|---|---|---|---|
| **3a** | M11 `20260927100000`, M12 `20260927110000`, M13 `20260927120000`, M15 `20260927130000` | additive for existing clients; the legacy RPC remains as a v2 wrapper | batch 2 minimum `2919523` (unchanged) |
| **3b** | M14 `20260927140000` | removes the legacy RPC: every live frontend must already call v2 | live frontend must contain `a5ed4e8` (M12 frontend), or `no-live-frontend` |

With no live frontend (G5: hosting undecided), 3a and 3b may run back to
back. With a live frontend: 3a → deploy a frontend ≥ `a5ed4e8` → 3b.

## Starting point

SplitChat-Dev already had M11 (applied for the CA-2 proof, 26/26 through
real GoTrue — `scripts/rehearsal/api-ca2.mjs`). M11's rollback cannot remove
the `auth.users` trigger, and CA-2 deleted accounts (tombstones), so dev
cannot be returned to the exact post-batch-2 state without recreating the
project (a gated action). The rehearsal therefore starts from post-M11:

- `dev.mjs dump` vs the harness schema after `20260927100000`:
  **IDENTICAL (1752 normalised lines)** — dev is exactly the reviewed
  post-M11 schema.

## 3a

1. `api-batch3.mjs prepare` (pre-M12 API): legacy RPC gave the extra cent
   to the first-listed (highest) UUID — a historical, non-canonical
   allocation recorded for step 4.
2. `prod.mjs --batch batch3a preflight`: target PASS, ledger snapshot
   recorded, locks PASS (0/0). **Expected ABORTs**, all caused by dev being
   post-M11: schema ≠ post-batch-2 schema; history has 12 versions, not 11;
   Q13 = 4 (the CA-2 tombstones; in production before M11,
   `profiles_id_fkey` makes Q13 structurally 0). Q11 = Q12 = Q16 = Q4 = Q5 = 0.
3. Staged exactly the 15 batch-3a files (digests checked against the
   `prod.mjs` manifest); pinned CLI `db push --dry-run` listed M12, M13, M15;
   `db push` applied them.
4. `prod.mjs --batch batch3a verify`: **VERIFY PASSED** — history = 15
   versions; **23/23 post-checks**; ledger snapshot identical before/after
   (19 expenses, 298.51, 48 splits, 24 groups, 49 memberships, 21 profiles,
   same digests); schema == reviewed `batch3a_expected_schema.sql`.
   - First run failed one post-check: the allowlist array was ordered by the
     database collation (en_US on Supabase, C in the harness). Fixed with
     `COLLATE "C"` in both post-check files; re-run PASSED.
5. `api-batch3.mjs verify3a`: **36/36** — historical allocation unchanged;
   v2 via supabase-js with integer cents and canonical shares; every probed
   error code with SQLSTATE P0001; S9 identical errors; anon denied;
   M13 creator/owner/member/outsider matrix, stale timestamp refused,
   `updated_at` round-trips exactly, direct UPDATE denied; M15 solo delete,
   active and former members block; legacy wrapper canonical with stable
   codes; **real GoTrue deletion** of a member who created and edited an
   expense succeeds (ledger intact, profile tombstoned) and the owner of a
   shared group is still refused.

## 3b

1. `prod.mjs --batch batch3b preflight`: **PREFLIGHT PASSED** (schema ==
   `batch3a_expected_schema.sql` exactly, history = 15, Q4/Q5 = 0, locks 0/0).
2. `dry-run`: exactly `20260927140000_drop_legacy_expense_rpc.sql`.
3. Push guards (all refused, nothing applied): no approval; approval for
   the wrong batch; attestation `f32b56d` (does not contain `a5ed4e8`);
   malformed attestation; `batch3a` push against a target whose history is
   not the batch-3a start.
4. `push` with `SPLITCHAT_PROD_APPROVAL=batch3b`,
   `SPLITCHAT_FRONTEND_ATTESTATION=d023871`: applied M14.
5. `verify`: **VERIFY PASSED** — 16 versions, **23/23**, ledger identical,
   schema == `batch3b_expected_schema.sql`.
6. `api-batch3.mjs verify3b`: **28/28** (the common suite again, plus the
   legacy RPC returning PostgREST `PGRST202`).

## Frontend compatibility

- Production bundle at `d023871`: `create_equal_split_expense_v2` present;
  `"create_equal_split_expense"`, `"p_amount"` and `share_amount` absent;
  reads `amount_cents` / `share_cents`. `update_equal_split_expense` is
  tree-shaken (no edit UI in Phase 1; the RPC is covered by tests).
- `api-batch3.mjs` drives SplitChat-Dev with `@supabase/supabase-js` using
  the exact RPC names, argument shapes and column selections of
  `src/lib/expenseApi.ts`, `src/lib/membershipApi.ts` and the expense pages.
- Not done: an interactive browser session against SplitChat-Dev.

## Not re-run

`api.mjs verify` and `api-batch2.mjs verify` call the legacy RPC and are
batch-1/2 tools; after M14 they are superseded by `api-batch3.mjs`. CA-2
was not repeated (M12–M15 do not touch `auth.users` or the deletion
trigger); the 3a run includes one real deletion and one real refusal as a
regression check.

## Review fix QS-B3-1 (after QA/Security round 1)

`20260927135000_serialise_owner_deletion_and_member_add` joins batch 3a (it
sorts before M14). On SplitChat-Dev (then at post-3b):

1. `prod.mjs --batch batch3b preflight`: ledger snapshot and locks PASS;
   schema/history ABORT as expected (dev predates the fix).
2. Pinned CLI `db push --include-all` from a staging copy of all 17 files
   (the fix is older than the already-applied M14 on dev; in production it
   is applied in order as part of 3a): applied only `20260927135000`.
3. `prod.mjs --batch batch3b verify`: **VERIFY PASSED** — 17 versions,
   **24/24** post-checks (new: both functions lock the group row), ledger
   unchanged, schema == regenerated `batch3b_expected_schema.sql`.
4. **CA-2 re-run through real GoTrue: 26/26** (the trigger body changed, so
   the earlier evidence no longer covered the final function).
   `api-ca2.mjs` now creates its expenses with v2.
5. `api-batch3.mjs verify3b`: **28/28**.

The two-session interleavings themselves are proven locally (case 175,
dblink) — they cannot be timed deterministically through the HTTP APIs.

### Round 2 (QS-B3-2, LOW)

QA/Security round 2 confirmed QS-B3-1 closed and noted that the RPC's
re-check sat after the counted rate-limit insert, so a raise could roll back
a counted attempt (contradicting CA-1). The lock and re-check now precede the
attempt bookkeeping, and the post-check asserts that order. SplitChat-Dev
already recorded `20260927135000`, so the same reviewed file (idempotent
`CREATE OR REPLACE`) was re-executed with `dev.mjs file`; then
`prod.mjs --batch batch3b verify`: **VERIFY PASSED (24/24, ledger unchanged,
schema == regenerated `batch3b_expected_schema.sql`)**; `api-batch3.mjs
verify3b` **28/28**; CA-2 **26/26**. In production the file is applied once,
in order, as part of 3a.

## Clean rehearsal from production's state (2026-09-27, operator-approved dev reset)

Closes the gap above: batch 3a rehearsed through the exact production path
from an M0–M10 database.

**Reset (dev only).** No management API token exists, so the project was
reset in place rather than recreated: `dev.mjs check` (ref guard + sentinel)
→ `scripts/rehearsal/reset-dev-to-empty.sql` (re-checks the sentinel in the
database; one transaction; post-conditions asserted): removed the SplitChat
objects, `private`, the CLI history, both SplitChat triggers on
`auth.users` and all 36 synthetic auth users; restored the platform default
privileges M6 had revoked. No billing, no plan change; production not
contacted; synthetic data only.

**Finding:** M11's `auth.users` trigger *can* be removed by `postgres` as a
dependent object (`DROP FUNCTION private.handle_auth_user_deleting()
CASCADE`), although `DROP TRIGGER` is refused. See the approval report (M11
classification).

**Replay of production's history.**

| Step | Result |
|---|---|
| M0 applied directly (as production's baseline came about) | dump vs Phase 0 production capture: **IDENTICAL** (1292 lines, ACLs included) |
| `api.mjs seed` (pre-batch-1 API) | 7 users, 2 groups, 3 expenses |
| batch 1 via `prod.mjs --rehearse-on-dev`: preflight → `repair-m0` → dry-run (M1–M5) → push → verify | PREFLIGHT PASSED; **VERIFY PASSED 17/17** |
| batch 2: `api-batch2 prepare` → preflight → dry-run (M6–M10) → push (`no-live-frontend`) → verify → `api-batch2 verify` | PREFLIGHT PASSED; **VERIFY PASSED 22/22**; API **44/44** |

Dev was then exactly production's recorded state (schema ==
`batch2_expected_schema.sql`, history M0–M10).

**Batch 3a (exact production procedure).**

| Step | Result |
|---|---|
| `api-batch3 prepare` (legacy RPC, extra cent to the first-listed UUID) | 334 recorded for the highest UUID |
| `preflight` | **PREFLIGHT PASSED**: exact schema, 11 versions, Q11 = Q12 = Q13 = **Q16 = 0**, Q4 = Q5 = 0, locks 0/0 |
| Q16 negative test: one synthetic auth user with its profile removed | preflight **ABORT** (`Q16: 1`); user deleted; preflight re-run PASSED |
| `dry-run` | exactly `20260927100000`, `110000`, `120000`, `130000`, `135000` (no M14) |
| push without approval / with `batch3b` approval / without attestation | all refused |
| push, `SPLITCHAT_PROD_APPROVAL=batch3a`, `SPLITCHAT_FRONTEND_ATTESTATION=no-live-frontend` | the five migrations applied |
| push again | refused (history no longer the 3a start) |
| `verify` | **VERIFY PASSED**: 16 versions, **24/24**, ledger unchanged, schema == `batch3a_expected_schema.sql` |
| `api-batch3 verify3a` | **36/36** (historical allocation unchanged; canonical v2; M13 matrix and stale-write refusal; M15 solo-only; legacy wrapper; real GoTrue deletion after an edit; owner still refused) |
| `api-ca2.mjs` (real GoTrue) | **26/26** (blocked and allowed paths) |
| `api-race.mjs` (new): one side held open in a real session, the other through real GoTrue / PostgREST | **6/6**: add-first → deletion waits, then `owner_must_transfer`; delete-first → add waits, then `not_found_or_forbidden`; never an active member without an owner |
| read-only invariant sweep | unbalanced 0, no-split 0, multi-owner 0, active-without-owner 0, split-without-membership 0 |

**Batch 3b.** Legacy RPC unused: no runtime reference in `src/`, production
bundle (`7e6c9bf`) has 0 `"create_equal_split_expense"` / 0 `"p_amount"` and
calls `create_equal_split_expense_v2`. `preflight` PASSED (exact 3a schema,
16 versions); `dry-run` exactly `20260927140000`; attestation `f32b56d`
refused; push (`no-live-frontend`) applied M14; **VERIFY PASSED 24/24**;
`api-batch3 verify3b` **28/28** (legacy `PGRST202`); CA-2 again **26/26**;
race **6/6**.

## Production preflight failure and tooling fix (2026-09-27)

The operator's read-only `prod.mjs --batch batch3a preflight` stopped after
the drift gate with `ERROR: Unexpected end of JSON input` (target and drift
gates PASS; the read-only dry-run listed exactly the five 3a migrations).

**Cause.** The pinned Supabase CLI 2.117.0 picks its default output format
from the environment: when it detects an AI agent (`AI_AGENT`, `CLAUDECODE`,
... — set in every rehearsal, which ran under Claude Code) `migration list`
prints JSON; in the operator's own shell it prints a text table.
`remoteVersions()` sliced stdout from the first `{` to the last `}`; the
table has neither, the slice was `''`, and `JSON.parse('')` threw. The gate
failed closed (correct), but the rehearsals had not reproduced the
operator's environment. Reproduced on SplitChat-Dev with the pre-fix tool
and all agent variables removed: the same two lines, then the same error.

**Fix (tooling only; no gate weakened).**
- `scripts/ops/cliOutput.mjs`: `parseMigrationList` requires the *whole*
  stdout to be one JSON document with a `migrations` array of 14-digit
  versions; empty, truncated, table, trailing/leading text, duplicates or
  malformed versions all throw `REFUSING: could not read the migration
  history ...` — never an empty or partial history.
- `prod.mjs`: `migration list --output-format json` (explicit); every CLI
  call gets `--agent no` and the CLI environment has the agent-detection
  variables removed, so rehearsals run exactly as the operator does.
  `dev.mjs cli` gets `--agent no` too.
- Tests: `scripts/ops/cliOutput.test.mjs` (24; the text table from the
  failure, empty, truncated and other malformed cases), now part of
  `npm test`.

**Verification on SplitChat-Dev, agent variables removed (operator's
environment):** `preflight` reads the history correctly (17 versions);
`verify` PASSED; with the agent environment as well: PASSED. The write path
was exercised in the operator's environment: dev returned to pre-3b with
M14's reviewed rollback and `migration repair --status reverted`, then
3b preflight (history, Q-checks, locks PASS; drift ABORT = ACL entry order
from that rollback only, IDENTICAL ignoring order), dry-run (exactly M14),
push, **VERIFY PASSED 24/24**.

## PRODUCTION batch 3a — executed and verified (2026-09-27)

Operator execution approval (in conversation): batch 3a only — the five
files below — on `jhftlnsccurhfgneltgi`, frontend attestation
`no-live-frontend`; no M14, no batch 3b, no rollback without separate
approval. Run by the operator in their own PowerShell (`DB_URL` exists only
there) from commit `25b7deb`; results below are as reported by the
operator. No rollback, retry or recovery action was needed.

| Step | Result |
|---|---|
| fresh `preflight` | target `jhftlnsccurhfgneltgi`; schema exact pre-3a; history exactly 11 (M0–M10); Q11 = Q12 = Q13 = **Q16 = 0**, Q4 = Q5 = 0; ledger snapshot recorded; 0 conflicting locks; 0 long transactions — **PREFLIGHT PASSED** |
| `dry-run` | exactly `20260927100000`, `20260927110000`, `20260927120000`, `20260927130000`, `20260927135000`; M14 not included |
| `push` (`SPLITCHAT_PROD_APPROVAL=batch3a`, `SPLITCHAT_FRONTEND_ATTESTATION=no-live-frontend`) | applied; exit 0; variables cleared |
| `verify` against the same preflight evidence | history **PASS (16 versions)**; post-checks **PASS 24/24**; ledger unchanged **PASS**; schema == reviewed post-3a schema **PASS** — **VERIFY PASSED** |

The 24 post-checks include: M11 (no profiles cascade from `auth.users`;
memberships/creators → profiles RESTRICT; expenses RESTRICT from groups;
`deleted_at`; BEFORE DELETE trigger enabled and bound; operator release not
executable by any client/service role), M12 (stored generated cents
columns; every expense `amount_cents = amount×100 = Σ share_cents`;
canonical allocation 334/333/333 to the lowest UUID; legacy RPC is the v2
wrapper), M13 (`updated_by` → profiles; exact authenticated EXECUTE
allowlist incl. update/delete), M15 (`delete_group` in the allowlist; no
service_role grant), the QS-B3-1/2 fix (both functions lock the group row;
add-by-email before counting the attempt), and the batch 1/2 controls.

Applied file digests (LF-normalised SHA-256, pinned in `prod.mjs`):
`20260927100000` `26cea13e…1cb4`, `20260927110000` `5cb96e48…bbf4`,
`20260927120000` `616feb16…a873`, `20260927130000` `0204022c…e3c1`,
`20260927135000` `ddf392bc…8c96` (full values:
`docs/phase1/batch3-approval-report.md` §2).

Production is now at **M0–M13, M15 and `20260927135000`** (16 versions).
M11 is live: fix-forward only.

## PRODUCTION batch 3b (M14) — executed and verified (2026-09-27)

Operator execution approval (in conversation): M14
`20260927140000_drop_legacy_expense_rpc.sql` only, on
`jhftlnsccurhfgneltgi`, attestation `no-live-frontend`. Run by the operator
in their own PowerShell from commit `43e02ed` with a script that stopped
before writing unless: identify = production `jhftlnsccurhfgneltgi`;
preflight PASSED (exact post-3a schema, 16-version history, Q4 = Q5 = 0,
locks clear); dry-run listed exactly M14. Results as reported by the
operator; no rollback, retry or recovery was needed.

| Step | Result |
|---|---|
| identify, preflight, dry-run | all conditions met (script would otherwise have stopped before the write) |
| `push` (`SPLITCHAT_PROD_APPROVAL=batch3b`, `SPLITCHAT_FRONTEND_ATTESTATION=no-live-frontend`) | M14 applied; variables cleared |
| `verify` against the same preflight evidence | history **PASS (17 versions)**; post-checks **PASS 24/24** (incl. legacy numeric RPC absent; v2 present in the exact authenticated EXECUTE allowlist, no anon/service_role); ledger unchanged **PASS**; schema == `batch3b_expected_schema.sql` **PASS** — **VERIFY PASSED** |

**Production is at the complete batch 3 state: M0–M15 plus `20260927135000`
(17 versions), schema == reviewed `batch3b_expected_schema.sql`.**
