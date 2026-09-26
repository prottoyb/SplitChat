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
