# Production release runbook — batch 4 (M16–M23)

**Status:** prepared, NOT executed. Every step that touches production is
run by the operator in their own shell, and only after explicit execution
approval of this batch (Mandatory Gate #5). Evidence and rationale:
`docs/phase8/release-batch4.md`.

## 0. Prerequisites

- Integration PR merged to `main` (or the release commit otherwise
  approved), CI green on it.
- Local checkout at the release commit; `npm ci`; PostgreSQL 17 client
  binaries (`psql`, `pg_dump`) available (`SPLITCHAT_PG_BIN` if not default).
- `DB_URL` for the production **session pooler** (port 5432) set only in
  the operator's shell. It never enters an agent's environment.
- No live frontend (`no-live-frontend`), or the live frontend's commit for
  the attestation (it must contain `a5ed4e8`).
- Recommended: a Supabase backup/PITR point noted just before step 3.
- Recommended beforehand (needs approval to reset SplitChat-Dev in place):
  a full dress rehearsal of steps 1–5 with `--rehearse-on-dev` from a Dev
  reset replayed to production's current state.

## 1. Identify and preflight (read-only)

```powershell
node scripts/ops/prod.mjs identify --batch batch4
node scripts/ops/prod.mjs preflight --batch batch4 "$env:TEMP\splitchat-evidence\batch4"
```

Must print `PREFLIGHT PASSED`:

- live schema == `supabase/ops/batch3b_expected_schema.sql` exactly;
- migration history == the 17 versions M0–M15 + `20260927135000`;
- Q4 = Q5 = 0 (ledger balanced); Q20 = 0 (Realtime publication exists);
  Q21 = 0 (not FOR ALL TABLES); **Q22 = 0 (publication holds no table yet)**;
- ledger snapshot recorded; no other locks / long transactions.

If Q22 ≠ 0, stop: a table was published from the dashboard; assess before
continuing.

## 2. Dry run (read-only)

```powershell
node scripts/ops/prod.mjs dry-run --batch batch4
```

Must list exactly the eight files, in order:
`20260928100000_activity_event_log.sql`, `20260928110000_settlements.sql`,
`20260928120000_group_messages.sql`,
`20260929100000_smart_expense_candidates.sql`,
`20260929110000_expense_core_membership_locks.sql`,
`20260930100000_membership_and_expense_edit_locks.sql`,
`20260930110000_index_cleanup.sql`, `20260930120000_realtime_anon_silence.sql`.

## 3. Push (WRITE — only with execution approval)

```powershell
$env:SPLITCHAT_PROD_APPROVAL = 'batch4'
$env:SPLITCHAT_FRONTEND_ATTESTATION = 'no-live-frontend'   # or the live frontend commit
node scripts/ops/prod.mjs push --batch batch4
Remove-Item Env:SPLITCHAT_PROD_APPROVAL, Env:SPLITCHAT_FRONTEND_ATTESTATION
```

The tool stages hash-verified copies, requires the remote history to be
exactly the 17 starting versions, and pushes. Each file is its own
transaction; a failing file stops the push with nothing of that file
applied (earlier files stay applied — see §6).

## 4. Verify (read-only)

```powershell
node scripts/ops/prod.mjs verify --batch batch4 "$env:TEMP\splitchat-evidence\batch4"
```

Must print `VERIFY PASSED`: history == the 25 versions; 13/13 named
post-checks (RLS, grants, anon denial, publication == exactly
`group_messages` + `expense_candidates`, definer `search_path`, private
core, M22 indexes, M16 backfill, ledger balanced); ledger snapshot
unchanged; schema == `supabase/ops/batch4_expected_schema.sql` exactly.
Then the catalog security audit (read-only; every A-check must return 0
rows; must print `AUDIT PASSED`):

```powershell
node scripts/ops/prod.mjs audit --batch batch4 "$env:TEMP\splitchat-evidence\batch4"
```

## 5. Frontend

Deploy per `docs/operations/deployment.md` (only after step 4 passed).
Set the Auth Site URL / Redirect URLs (operator). Smoke test.

## 6. If something fails

| Where | Action |
|---|---|
| Preflight / dry run | Stop. Nothing was written. Assess, fix the package, re-review. |
| Push stops mid-batch | Files up to the failing one are applied (each atomic). Do **not** re-push blindly: run `verify` to see the state, assess, then fix forward (corrected migration through review) or roll back the applied files with approval. |
| Verify fails | Stop and assess before deploying the frontend (the old frontend keeps working: the batch is additive for it). |

## 7. Rollback vs fix-forward

| Migration | Classification |
|---|---|
| M16 activity log | Fix-forward once live events exist (rollback discards history; needs approval) |
| M17 settlements | Fix-forward once payments exist (rollback discards payment history; needs approval) |
| M18 group messages | Fix-forward once messages exist |
| M19 candidates + shared core | Fix-forward once proposals exist; the core refactor alone could be reverted (rollback restores v2 verbatim) |
| M20, M21 lock discipline | Safe rollback any time (function bodies only; no data) |
| M22 indexes | Safe rollback any time |
| M23 anon Realtime silence | Safe rollback any time (re-opens the anon "401" timing notices) |

Rollback scripts: `supabase/rollbacks/<version>_*.down.sql` (each proven
up/down/up in the harness). Any production rollback needs its own
execution approval.
