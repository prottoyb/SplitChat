# Production Batch 3b — approval report (M14 only)

**Status:** ready for the operator's decision. **Not executed.** Production
is at M0–M13, M15 and `20260927135000` (batch 3a, executed and verified
2026-09-27: 16 versions, VERIFY PASSED). This report asks for one execution
approval (CLAUDE.md Mandatory Gate #5): **batch 3b = M14 only**.

## 1. The change

`supabase/migrations/20260927140000_drop_legacy_expense_rpc.sql` —
`DROP FUNCTION public.create_equal_split_expense(uuid, text, numeric, date,
uuid, uuid[], text)`, preceded by `SET LOCAL lock_timeout = '5s'`. Since M12
this function is only a wrapper around `create_equal_split_expense_v2`; it
is the last way to create an expense with a floating-point amount and the
last function granted to `service_role` among the expense RPCs. Nothing
else changes: no table, no data, no other function or grant.

| File | SHA-256 (LF-normalised, as `prod.mjs` checks) |
|---|---|
| `supabase/migrations/20260927140000_drop_legacy_expense_rpc.sql` | `e3e653568265e5bd13185bc960f5e3c971ec42b844d0df267bf9a5e7c7c551ad` |
| `supabase/rollbacks/20260927140000_drop_legacy_expense_rpc.down.sql` | `77027e1ce4d3ec8ba0b43ddbef54c8cbbcbb3cf7d2d834bcef943e37536b3817` |
| `supabase/ops/batch3a_expected_schema.sql` (required *before*) | `1cfc040c309b810ca8c7461d62998122f3fa91da3b2056610e4723851805d854` |
| `supabase/ops/batch3b_expected_schema.sql` (required *after*) | `0804dc02e90b430c94c9a468322542cdbfbcee4f5ca1380d41b859663967ea5c` |
| `supabase/ops/batch3_prechecks.sql` | `b0b4e925bcd7f2c81e43cb789cbc8396741a10f13ea9ff396a38038891a0c35b` |
| `supabase/ops/batch3b_postchecks.sql` | `21f0d56f1932fb34b4d3d0b5c3c83558f29e2a5e63c5a319534d7bfb4db650e1` |
| `supabase/ops/lock_check.sql` | `c782755c58be8781415832b7fe5f9fe65065dd926aa7905fe034bb77e84bdb04` |
| `supabase/ops/ledger_snapshot.sql` | `c3aa82794cb8cf4c9c58afa0235e84a5e9b21b5abbe8e3683095482ec90f3aac` |
| `scripts/ops/prod.mjs` | `d9a3f22037b86e19de351b031bb176db307a7e8cc3a795555a8b3b1842e779da` |
| `scripts/ops/cliOutput.mjs` | `bc4496226c453ed148f6d65c5f05976a0df5d83d1bc889b5a67687867235761d` |

`prod.mjs` batch `batch3b`: migrations = the 16 already applied plus M14
(all digests pinned); required start history = exactly the 16 batch-3a
versions; zero-checks Q4, Q5; `frontendMinCommit = a5ed4e85e9a1…07753`.

## 2. Frontend compatibility attestation

- **Attestation to use: `no-live-frontend`** (the operator's statement: no
  hosted SplitChat frontend exists; G5 hosting undecided). `prod.mjs`
  refuses the push without an attestation, and refuses a commit attestation
  that does not contain `a5ed4e8` (tested: `f32b56d` refused).
- If a frontend is ever deployed before 3b, it must be built from a commit
  containing `a5ed4e8`; then attest that commit instead.

## 3. Proof the legacy RPC is unused

- **Source:** no runtime reference to `create_equal_split_expense` (legacy)
  anywhere in `src/` since `a5ed4e8`; all expense writes go through
  `src/lib/expenseApi.ts` (v2 / update / delete). Re-checked at this commit.
- **Build:** the production bundle contains `create_equal_split_expense_v2`
  and zero occurrences of `"create_equal_split_expense"` or `"p_amount"`.
- **Tests:** Vitest asserts the page calls v2 with integer `p_amount_cents`
  and never sends `p_amount`.
- **Repository tooling:** only the historical batch-1/2 rehearsal scripts
  (`api.mjs`, `api-batch2.mjs`) call it, against pre-M12 schemas; they are
  superseded by `api-batch3.mjs` and are not runtime dependencies.
- **Consumers:** no live frontend (attested); no other client is known.
  Production call statistics were not collected (read-only access to
  `pg_stat_user_functions` would need its own approval and depends on
  `track_functions`); with no hosted frontend, the only possible callers are
  developers' local builds, which since `a5ed4e8` use v2.

## 4. Evidence

- **Local harness:** M14 up → down → up exact (rollback restores the wrapper
  with identical grants and comment); cases 070/180 exercise the wrapper via
  the reviewed rollback; `test:db` 23/23, 440 assertions.
- **SplitChat-Dev, clean rehearsal from M0–M10 (2026-09-27):** after 3a,
  `prod.mjs --batch batch3b` preflight PASSED (exact post-3a schema, 16
  versions); dry-run exactly M14; stale attestation refused; push; **VERIFY
  PASSED 24/24**; `api-batch3 verify3b` **28/28** (legacy → PostgREST
  `PGRST202`; v2, update, delete, delete_group fully functional); CA-2
  26/26 and race 6/6 afterwards.
- **Operator's environment:** the 3b write path was also rehearsed on dev
  with all agent-detection variables removed (as in the operator's shell):
  preflight gates, dry-run (exactly M14), push, **VERIFY PASSED 24/24**.
- **Production 3a** (same tool, same session style): preflight, push and
  verify all passed; production is exactly the reviewed pre-3b schema.

## 5. Reviews

- M14 (with batch 3): QA/Security **PASS → CONFIRMED** (no open findings);
  Senior Review **APPROVE**.
- Tooling fix `14e4a3d` (strict migration-history parsing, `--agent no`):
  QA/Security **PASS**; Senior **APPROVE** (LOW comment resolved in
  `25b7deb`).
- No unresolved CRITICAL/HIGH/MEDIUM finding.

## 6. Exact commands (operator's PowerShell, new `DB_URL`)

```powershell
# ---- Part 1: fresh read-only preflight + dry-run (no write) ----
$ErrorActionPreference = 'Stop'
Set-Location D:\Projects\SplitChat
git fetch origin
if ((git rev-parse HEAD) -ne (git rev-parse origin/feature/phase1-db-hardening)) { throw 'not at the reviewed branch head - stop' }
$ev = "$env:TEMP\splitchat-evidence\batch3b-prod"
if (Test-Path $ev) { Remove-Item -Recurse -Force $ev }
node scripts/ops/prod.mjs --batch batch3b identify;         if ($LASTEXITCODE -ne 0) { throw 'identify failed - stop' }
node scripts/ops/prod.mjs --batch batch3b preflight $ev;    if ($LASTEXITCODE -ne 0) { throw 'PREFLIGHT FAILED - stop' }
Get-Content "$ev\prechecks.txt"
node scripts/ops/prod.mjs --batch batch3b dry-run;          if ($LASTEXITCODE -ne 0) { throw 'dry-run failed - stop' }
```

Continue only if preflight printed **PREFLIGHT PASSED** (exact schema,
history = the 16 batch-3a versions, Q4 = Q5 = 0, locks clear) and the
dry-run lists exactly `20260927140000_drop_legacy_expense_rpc.sql`.

```powershell
# ---- Part 2: the approved write, then read-only verification ----
$ErrorActionPreference = 'Stop'
Set-Location D:\Projects\SplitChat
$ev = "$env:TEMP\splitchat-evidence\batch3b-prod"
if (-not (Test-Path "$ev\ledger_before.txt")) { throw 'preflight evidence missing - stop' }
$env:SPLITCHAT_PROD_APPROVAL = 'batch3b'
$env:SPLITCHAT_FRONTEND_ATTESTATION = 'no-live-frontend'
try {
    node scripts/ops/prod.mjs --batch batch3b push
    $pushExit = $LASTEXITCODE
}
finally {
    Remove-Item Env:SPLITCHAT_PROD_APPROVAL -ErrorAction SilentlyContinue
    Remove-Item Env:SPLITCHAT_FRONTEND_ATTESTATION -ErrorAction SilentlyContinue
}
if ($pushExit -ne 0) { throw "PUSH FAILED (exit $pushExit) - stop; do not retry or roll back without approval" }
node scripts/ops/prod.mjs --batch batch3b verify $ev
if ($LASTEXITCODE -ne 0) { throw "VERIFY FAILED (exit $LASTEXITCODE) - stop and report" }
Write-Host 'Batch 3b applied and VERIFY PASSED - stop here.'
```

`verify` requires: history = exactly 17 versions (batch 3a + M14); all
24 batch-3b post-checks true (including "the legacy numeric expense RPC is
gone" and the authenticated EXECUTE allowlist without it); ledger snapshot
identical; schema == `batch3b_expected_schema.sql` exactly.

**Impact and locks:** one `DROP FUNCTION` in its own transaction with
`lock_timeout = 5s`; no table locks beyond catalog updates; no data change.

## 7. Rollback versus fix-forward

**Rollback available.** `supabase/rollbacks/20260927140000_drop_legacy_expense_rpc.down.sql`
recreates the M12 wrapper exactly (body, grants to authenticated and
service_role, comment) — proven up → down → up exact in the harness and on
SplitChat-Dev (where the only difference after rollback was ACL entry
order). In production it would be applied as a new forward migration under
its own approval (design F-W7). No data depends on the function.

## 8. Residual risks

1. A client older than `a5ed4e8` (e.g. an old local build pointed at
   production) can no longer add expenses; mitigated by `no-live-frontend`.
2. Consumer-free status rests on the operator's attestation and repository
   evidence, not on production call statistics.
3. Carried over (unchanged by 3b): M11 fix-forward; orphaned groups without
   a cleanup path (DS-3); permanent expense/solo-group deletion until the
   Phase 3 activity history; no CI; hosting undecided (G5).

## 9. Decision requested

Execution approval for **batch 3b (M14 only)** on `jhftlnsccurhfgneltgi`
with attestation `no-live-frontend`, via §6. Not requested: any rollback,
PR/merge, the Phase 1 completion gate, or the next phase.
