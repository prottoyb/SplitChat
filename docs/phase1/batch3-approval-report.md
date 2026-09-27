# Production Batch 3 — approval report (M11–M15)

**Status: EXECUTED.** Batch 3a applied and verified in production
2026-09-27 (from `25b7deb`, after the preflight tooling fix `14e4a3d`);
batch 3b (M14) applied and verified 2026-09-27 (from `43e02ed`). See
`docs/phase1/batch3-rehearsal.md`. The text below is the report as
originally prepared; `prod.mjs` changed afterwards (`14e4a3d`, `25b7deb`) —
its current digest is in `batch3b-approval-report.md`. **Originally: nothing had been run
against production.** Production is at M0–M10 (checkpoint `f32b56d`,
verified at batch 2). This report asks for two separate execution
approvals (CLAUDE.md Mandatory Gate #5): **batch 3a**, then **batch 3b**.

Branch `feature/phase1-db-hardening`; reviewed head: the commit that adds
this report (code head `457d6b2`). Evidence details:
`docs/phase1/batch3-rehearsal.md`; design record: `docs/phase1/design.md`
("Batch 3 review round 1"), ADR-0002/0005/0006.

## 1. What each step does

| Step | Migration | Effect |
|---|---|---|
| 3a | M11 `20260927100000_ledger_preserving_account_deletion` | Profiles outlive auth accounts; memberships and group creators reference `profiles` (RESTRICT); expenses no longer cascade from groups; `profiles.deleted_at`; BEFORE DELETE trigger on `auth.users` (refuses `owner_must_transfer` for owners of shared groups, otherwise marks memberships `account_deleted` and tombstones the profile; ledger untouched); `private.admin_release_ownership` (postgres only). Backfills missing profiles (pre-check Q16 requires none). |
| 3a | M12 `20260927110000_money_cents_and_canonical_split` | Generated `amount_cents` / `share_cents`; `private.equal_split_cents` (canonical: ascending UUID, remainder to the first); `create_equal_split_expense_v2(p_amount_cents bigint)` with stable error codes; legacy numeric RPC becomes a v2 wrapper. **Existing rows are not rewritten.** |
| 3a | M13 `20260927120000_expense_update_delete_rpcs` | `update_equal_split_expense`, `delete_expense` (creator while active, or active owner; optimistic concurrency); `expenses.updated_by`. |
| 3a | M15 `20260927130000_delete_group_rpc` | `delete_group`: only the active owner, only if nobody else was ever a member and no record refers to anyone else. |
| 3a | `20260927135000_serialise_owner_deletion_and_member_add` | Review fix QS-B3-1/QS-B3-2: the deletion trigger and `add_group_member_by_email` lock the group row and decide under it. |
| 3b | M14 `20260927140000_drop_legacy_expense_rpc` | Drops the legacy numeric expense RPC. |

Why two steps: a frontend older than `a5ed4e8` calls the legacy RPC (3b
removes it); a frontend at/after `a5ed4e8` calls v2 (3a adds it). With **no
live frontend** (G5: hosting undecided) 3a and 3b can run back to back. With
a live frontend: 3a → deploy a frontend ≥ `a5ed4e8` → 3b. `prod.mjs`
enforces this with `SPLITCHAT_FRONTEND_ATTESTATION`.

## 2. Files and SHA-256 (LF-normalised, as `scripts/ops/prod.mjs` checks)

| File | SHA-256 |
|---|---|
| `supabase/migrations/20260927100000_ledger_preserving_account_deletion.sql` | `26cea13e06de6a7149931c5165f2c2e03968d331e9b3c9a06787c1f46cb81cb4` |
| `supabase/migrations/20260927110000_money_cents_and_canonical_split.sql` | `5cb96e482d792b3d8a8b0cc6a42687f2ddb40fcf78d7bc6d781e4f410bbbfbf4` |
| `supabase/migrations/20260927120000_expense_update_delete_rpcs.sql` | `616feb16aa85741a70c4155d80111126f752eac0b341a5d88449f72e9ff6a873` |
| `supabase/migrations/20260927130000_delete_group_rpc.sql` | `0204022c08cad6509db756792c925b9e89f43d5d61bf0c232a7873da56a8e3c1` |
| `supabase/migrations/20260927135000_serialise_owner_deletion_and_member_add.sql` | `ddf392bca3cff2dea4ff47f563ec21b96fe0b564e7f8583354c9f8686d148c96` |
| `supabase/migrations/20260927140000_drop_legacy_expense_rpc.sql` | `e3e653568265e5bd13185bc960f5e3c971ec42b844d0df267bf9a5e7c7c551ad` |
| `supabase/rollbacks/20260927100000_ledger_preserving_account_deletion.down.sql` | `6293ae54194d65fb499cea0b4e650aadc4fa5052ef501e5dc9afeef911cb964c` |
| `supabase/rollbacks/20260927110000_money_cents_and_canonical_split.down.sql` | `55eba67157407ecd4dd3c4a989495f7fb003baf8817ab8c797be46d2da66f2b1` |
| `supabase/rollbacks/20260927120000_expense_update_delete_rpcs.down.sql` | `f7c0948bdb9b60d5a1d45e8f9c27048699e918af668960a78ed51f12abff4a4a` |
| `supabase/rollbacks/20260927130000_delete_group_rpc.down.sql` | `6be362b3fe5b48adb6ce54b75010b2c3bf7aaf7fe4370478a1008ce562c06c88` |
| `supabase/rollbacks/20260927135000_serialise_owner_deletion_and_member_add.down.sql` | `8e6be2aad3bb1b0750f681da65a08c151a59ee9c42e4f5554dc3151e1c42aec4` |
| `supabase/rollbacks/20260927140000_drop_legacy_expense_rpc.down.sql` | `77027e1ce4d3ec8ba0b43ddbef54c8cbbcbb3cf7d2d834bcef943e37536b3817` |
| `supabase/ops/batch3_prechecks.sql` | `b0b4e925bcd7f2c81e43cb789cbc8396741a10f13ea9ff396a38038891a0c35b` |
| `supabase/ops/batch3a_postchecks.sql` | `81ebc2be489a0ed9833b9f3bf978cc6a061f1364c25696cd16cc6ba5f5da0d6a` |
| `supabase/ops/batch3b_postchecks.sql` | `21f0d56f1932fb34b4d3d0b5c3c83558f29e2a5e63c5a319534d7bfb4db650e1` |
| `supabase/ops/batch3a_expected_schema.sql` | `1cfc040c309b810ca8c7461d62998122f3fa91da3b2056610e4723851805d854` |
| `supabase/ops/batch3b_expected_schema.sql` | `0804dc02e90b430c94c9a468322542cdbfbcee4f5ca1380d41b859663967ea5c` |
| `supabase/ops/lock_check.sql` | `c782755c58be8781415832b7fe5f9fe65065dd926aa7905fe034bb77e84bdb04` |
| `supabase/ops/ledger_snapshot.sql` | `c3aa82794cb8cf4c9c58afa0235e84a5e9b21b5abbe8e3683095482ec90f3aac` |
| `scripts/ops/prod.mjs` | `6e93970b16a97a6a9bcf232fdad12d0b9b48f23186f0169c99398f9d6a58476b` |

`prod.mjs` pins every migration and expected-schema digest itself and
refuses to stage a file that differs.

## 3. Evidence

**CA-2 (M11 through real Supabase Auth, SplitChat-Dev):** `api-ca2.mjs`
**26/26** — blocked owner deletion is atomic (auth user, identities, refresh
tokens, profile, memberships and ledger unchanged; the owner can still sign
in); allowed member deletion tombstones the profile ("Deleted user"),
marks memberships `account_deleted` and leaves the ledger byte-identical;
transfer-then-delete, operator release-then-delete and sole-owner deletion
(group retained, orphaned) all work. **Re-run on the final trigger body**
(after the QS-B3-1 fix): 26/26.

**M11 fix-forward classification:** Supabase lets `postgres` create but not
drop a trigger on `auth.users`. The reviewed rollback neutralises the
function (the trigger stays) and cannot restore `profiles_id_fkey` once any
account has been deleted. M11 is therefore **fix-forward only**; the harness
declares this (`rollback-residual`, `rollback-no-reup`) and tests the
partial rollback.

**M12 canonical split:** 17 shared vectors
(`src/lib/fixtures/equal-split-vectors.json`) run against
`allocateEqualSplit` (Vitest) and against `private.equal_split_cents` and
end to end through v2 (case 180, 118 assertions): remainder to the lowest
UUID, independent of input order, mixed case, max amount, error codes.
Case 181: M12 applied to a populated ledger changes **no stored value**
(every column of every expense and split) and keeps a historical
non-canonical allocation as recorded; confirmed on SplitChat-Dev (legacy
allocation 334/333/333 to the first-listed UUID unchanged after 3a).

**M13 authorization:** case 190 (67 assertions): creator while active ✓;
owner of the group ✓; other member `forbidden`; former member, creator who
left, outsider and nonexistent expense `not_found_or_forbidden` (identical,
S9); owner of another group cannot cross; edits of description, amount,
date, payer and participant set recompute canonical splits and pass the
deferred invariants; former members kept but never added; every error code;
lost update refused (`stale_expense`). Mutation check: removing the
`forbidden` rule fails the case. SplitChat-Dev: the same matrix through
supabase-js.

**M14 frontend compatibility / attestation:** no frontend path calls the
legacy RPC since `a5ed4e8` (repository search; the production bundle
contains only `create_equal_split_expense_v2`, no `p_amount`, no
`share_amount`). SplitChat-Dev after 3b: legacy RPC `PGRST202`, v2 suite
28/28. `prod.mjs` batch 3b refuses without an attestation containing
`a5ed4e8` (tested: stale `f32b56d` and malformed values refused).

**M15 historical-member deletion:** case 200 (35 assertions): solo group
(empty, or with the owner's private ledger) deleted; refused when any other
member exists — active, left, removed or account-deleted
(`group_has_other_members`); refused independently when any split, payer,
creator, last editor, `removed_by` or group creator refers to someone else,
including memberships hard-deleted before M7/M10
(`group_has_shared_history`); authorization first (S9); orphaned and
transferred-away groups refused; add-by-email rate-limit history survives.
Mutation checks: an active-only member count, or removing the history
check, fails the case. SplitChat-Dev: former member blocks, solo delete
works.

**QS-B3-1 concurrency:** case 175 runs both interleavings (delete-first,
add-first) in two real sessions (dblink) and fails without the fix.

**SplitChat-Dev rehearsal:** dev was exactly the reviewed post-M11 schema;
3a applied with the pinned CLI from a verified staging copy →
`prod.mjs verify` **PASSED** (post-checks all true, ledger snapshot
identical, schema == reviewed); API **36/36**. 3b through the full
production-tool path (preflight PASSED, dry-run = M14 only, guards refused
bad approvals/attestations/history, push, verify PASSED); API **28/28**.
Review fix applied and verified (24/24 post-checks, schema == final).
Limitation: dev could not be reset to post-batch-2 (the `auth.users`
trigger cannot be dropped and CA-2 deleted accounts), so the 3a preflight
and push were not dress-rehearsed end to end from a post-batch-2 target;
the push path is the batch-2-rehearsed code, and its history guard was
exercised.

**Local validation (at `457d6b2`):** lint ✅; build ✅ (known chunk-size
warning); Vitest **190/190**; `npm audit` **0**; `test:db` **23/23 cases,
440 assertions**, baseline round-trip exact, rollback up/down/up for every
migration (M11 up/down only, declared).

## 4. Reviews

- **QA/Security** (independent `qa-security`, `project-security-review`):
  round 1 **PASS** with QS-B3-1 (MEDIUM, race leaving a group with an
  active member and no owner) — fixed; round 2 **PASS** with QS-B3-2 (LOW,
  re-check after counted attempt) — fixed; final: **CONFIRMED, no open
  findings at any severity**.
- **Senior Review** (independent `senior-reviewer`): round 1 **APPROVE WITH
  CONDITIONS** (phase-state accuracy; rehearsal doc untracked) — fixed;
  round 2 **APPROVE**; confirmed after QS-B3-2: **APPROVE**.
- No unresolved CRITICAL/HIGH/MEDIUM finding (Mandatory Gate #2).

## 5. Production pre-flight (read-only; part of each approval)

Not yet run — a production read also requires the operator. Expected:

- 3a: live schema == `batch2_expected_schema.sql` (exact); history = M0–M10;
  **Q11 = Q12 = Q13 = Q16 = Q4 = Q5 = 0**; no locks on
  expenses/expense_splits/groups/group_members/profiles and no transaction
  older than 5 s. If Q16 > 0 (auth users without a profile), stop: M11's
  backfill would write data and the ledger-unchanged gate would fail —
  a separate decision is needed.
- 3b: live schema == `batch3a_expected_schema.sql`; history = batch 3a;
  Q4 = Q5 = 0; locks clear.

## 6. Exact production commands (operator's PowerShell, `DB_URL` = session pooler)

```powershell
# ---- Batch 3a (needs execution approval "batch 3a") ----
node scripts/ops/prod.mjs --batch batch3a identify
node scripts/ops/prod.mjs --batch batch3a preflight "$env:TEMP\splitchat-evidence\batch3a"     # must print PREFLIGHT PASSED
node scripts/ops/prod.mjs --batch batch3a dry-run                        # must list exactly 20260927100000, 110000, 120000, 130000, 135000
$env:SPLITCHAT_PROD_APPROVAL = 'batch3a'
$env:SPLITCHAT_FRONTEND_ATTESTATION = 'no-live-frontend'                  # or the live frontend commit (must contain 2919523)
node scripts/ops/prod.mjs --batch batch3a push
Remove-Item Env:SPLITCHAT_PROD_APPROVAL, Env:SPLITCHAT_FRONTEND_ATTESTATION
node scripts/ops/prod.mjs --batch batch3a verify "$env:TEMP\splitchat-evidence\batch3a"        # must print VERIFY PASSED

# ---- (only with a live frontend) deploy a frontend build >= a5ed4e8 ----

# ---- Batch 3b (needs execution approval "batch 3b") ----
node scripts/ops/prod.mjs --batch batch3b preflight "$env:TEMP\splitchat-evidence\batch3b"
node scripts/ops/prod.mjs --batch batch3b dry-run                        # must list exactly 20260927140000
$env:SPLITCHAT_PROD_APPROVAL = 'batch3b'
$env:SPLITCHAT_FRONTEND_ATTESTATION = 'no-live-frontend'                  # or the live frontend commit (must contain a5ed4e8)
node scripts/ops/prod.mjs --batch batch3b push
Remove-Item Env:SPLITCHAT_PROD_APPROVAL, Env:SPLITCHAT_FRONTEND_ATTESTATION
node scripts/ops/prod.mjs --batch batch3b verify "$env:TEMP\splitchat-evidence\batch3b"        # must print VERIFY PASSED
```

Stop at any ABORT/FAILED line. The evidence directories (outside the
repository) hold schema dumps and aggregate outputs only; `verify` reads the
ledger snapshot that `preflight` wrote to the same directory.

**Impact and locks:** each migration runs in its own transaction with
`lock_timeout = 5s` (fails cleanly rather than queueing). M11 briefly takes
locks on `group_members`, `groups`, `expenses`, `profiles` and creates a
trigger on `auth.users` (blocks concurrent auth writes, e.g. sign-ups, for
the moment of creation). M12 rewrites `expenses` and `expense_splits` once
(generated columns) under an exclusive lock; the tables are small. No data
is transformed; the only write is M11's profile backfill, required to be
empty.

## 7. Rollback versus fix-forward

Any rollback in production is a new forward migration with its own approval
(design F-W7).

| Migration | Classification | Notes |
|---|---|---|
| M11 | **Fix-forward only** | Trigger on `auth.users` cannot be dropped by `postgres`; after any account deletion `profiles_id_fkey` cannot return. Partial rollback neutralises the handler only. |
| M12 | Rollback available (after rolling back M13/M15-fix dependents and M14) | Drops v2, the allocation function and derived columns; no stored value changes. Requires the frontend to go back before `a5ed4e8`. |
| M13 | Rollback available | Removes edit/delete; completed edits/deletions stay; `updated_by` kept if it holds data. |
| M15 | Rollback available | Removes group deletion; deleted solo groups are not restored. |
| `135000` fix | Rollback available (not advised) | Restores the unlocked bodies and reopens QS-B3-1. |
| M14 | Rollback available | Recreates the legacy wrapper with its exact grants and comment. |

## 8. Residual risks after M15

1. **M11 is permanent** in practice (fix-forward); a future Supabase change
   to `auth` schema handling could affect the trigger. GoTrue *soft*
   delete bypasses it; hard delete (dashboard/admin API) is the supported
   path.
2. **Orphaned groups** (sole owner deleted their account) remain with zero
   active members, invisible and not actionable (DS-3); no cleanup/export
   path yet.
3. **Deletions are permanent** (expenses by creator/owner; solo groups): no
   soft delete or activity log until Phase 3.
4. **No expense edit UI** in Phase 1; the update RPC is tested but unused.
5. **Frontend attestation relies on the operator's statement** (G5: no
   hosting/CI). No CI exists; checks are run locally.
6. **Three-way concurrency** (deletion + transfer + add) is reasoned, not
   tested; the two-way race is tested.
7. **Rehearsal gap:** 3a preflight/push not dress-rehearsed from a
   post-batch-2 target (dev cannot be reset without recreating the project,
   a gated action).
8. Carried over: timing side channels in membership RPCs accepted (DS-10);
   `supabase_admin` default privileges not changeable by `postgres`;
   add-by-email reveals existence only on success (by design).

## 9. Decision requested

1. Execution approval for **batch 3a** as specified (§6), naming the
   frontend attestation value.
2. Separately, execution approval for **batch 3b**, after 3a VERIFY PASSED
   (and, if a frontend is live, after it is at or after `a5ed4e8`).

Separately gated and not requested here: PR/merge of the branch, any
rollback, `admin_release_ownership` in production, deleting SplitChat-Dev.
