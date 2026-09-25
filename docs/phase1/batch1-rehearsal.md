# Production batch 1: SplitChat-Dev rehearsal evidence

**Batch:** M0 history adoption (`migration repair`) plus M1–M5 (design §B).
**Rehearsed:** 2026-09-26 on SplitChat-Dev, a separate free-tier project,
ref `opviwtyfssxoheigflxw` in ap-northeast-1, running PostgreSQL 17.6 like
production. It holds synthetic data only.
**Production:** SplitChat, ref `jhftlnsccurhfgneltgi`. It was **not
touched**.

## Target safety

- **Dev project creation:** the org plan was checked read-only (`free`,
  one existing project) before SplitChat-Dev was created, so no billing
  applies.
- **Credentials:** the dev password is random. It and the dev API keys are
  kept only in git-ignored `.env.splitchat-dev.local`, and were never
  printed.
- **Tooling:** all rehearsal commands ran through `scripts/rehearsal/dev.mjs`
  and `api.mjs`, which:
  - refuse the production ref;
  - build the dev URL themselves and scrub `DB_URL` and all `PG*`
    variables from child processes;
  - verify a sentinel schema (`splitchat_rehearsal_sentinel`, commented
    with the dev ref) before every command. The sentinel is created only in
    a database with no app tables, so it can never be created in
    production.

## Procedure, mirroring the proposed production operation

| Step | Command | Result |
|---|---|---|
| 1 | Apply M0 directly, so dev becomes a replica of today's production | ok. The `auth.users` trigger can be created by `postgres` (**CA-2, creation part, proven**) |
| 2 | Dump `public` and compare with the Phase 0 production capture | **IDENTICAL** (1292 normalised lines, ACLs included) |
| 3 | Seed through the real APIs: 7 GoTrue users (1 unconfirmed, 1 with no groups); 2 groups created via the frontend's insert; members added via `add_group_member_by_email`; 3 expenses via `create_equal_split_expense` | ok |
| 4 | `supabase/ops/batch1_prechecks.sql` (read-only guard) | Q1–Q8 all **0** |
| 5 | `supabase/ops/ledger_snapshot.sql` (read-only) | recorded |
| 6 | `supabase migration list --db-url` | no remote history; 6 local migrations |
| 7 | `supabase migration repair --status applied 20260926000000 --db-url` | history table created; M0 recorded. `public` re-dumped: **IDENTICAL** to production (repair changes no schema) |
| 8 | `supabase db push --dry-run --db-url` | would push exactly M1–M5 |
| 9 | `supabase db push --yes --db-url` | M1–M5 applied; `migration list` shows all 6 applied. **No Docker needed** (design assumption proven) |
| 10 | Ledger snapshot again | **UNCHANGED**: counts, totals and row digests identical |
| 11 | `supabase/ops/batch1_postchecks.sql` (read-only) | **17/17 true** |
| 12 | Real-API behaviour checks (`scripts/rehearsal/api.mjs verify`) | **24/24 pass** (below) |
| 13 | SQL checks as `postgres` | M1 `immutable_field`; M4 `expense_unbalanced` at COMMIT; `split_type` check violation |
| 14 | Dev schema after M5 compared with the local harness after M5 (`npm run test:db -- --export-dump`) | **IDENTICAL** (1466 normalised lines; proves the Tier-1 shim is faithful) |

## Real-API checks (PostgREST and GoTrue, as the frontend and GoTrue call them)

- **M1/M3:** a creator's `PATCH expenses {group_id: other}` is refused
  (403 / 42501).
- **M2:** anonymous calls to `split_chat_is_group_member` and
  `create_equal_split_expense` are refused (401 / 42501).
- **M3:** direct INSERT of an expense, PATCH of a split and DELETE of an
  expense are all refused (42501).
- **The RPC path works:** a member creates a 12.50 expense split 3 ways.
  It commits through PostgREST (the deferred balance check runs at COMMIT
  as `authenticated`), and the splits total 1250 cents.
- **App reads still work:** groups, members, expenses and co-member
  profiles.
- **Isolation holds:** an outsider sees 0 expenses and 0 splits of another
  group, and anon cannot read expenses.
- **Membership writes still work:** group creation, a member leaving, and
  an owner being unable to remove their own membership. Historical splits
  of a member who left are kept.
- **M5 via the GoTrue admin API:**
  - Deleting a group owner is refused (GoTrue returns 500). The account,
    identity, profile and membership are left intact, the owner can still
    sign in, and the group ledger is intact.
  - A member with ledger history also can't be deleted yet (expected until
    M11).
  - An account with no groups or ledger rows is deleted normally.

## Migration files (the exact reviewed files; no diff against `2df7485`)

| File | SHA-256 (prefix) | git blob |
|---|---|---|
| `20260926000000_baseline_public_schema.sql` | `7d7b627b2cbfd270` | `c980b931fb5e` |
| `20260926100000_guard_expense_immutable_columns.sql` | `cc322ff60c033443` | `20760abc767b` |
| `20260926110000_revoke_anon_harden_definer_functions.sql` | `1a91b339524aea24` | `f6e93204fc3e` |
| `20260926120000_revoke_direct_ledger_writes.sql` | `477de1deebca0ad8` | `7c330a5628d4` |
| `20260926130000_enforce_ledger_invariants.sql` | `288fdd9b0ae0e868` | `f5b87e5fc5f6` |
| `20260926140000_restrict_owner_deletion_cascade.sql` | `f74b73c6ccbb2484` | `57edd5cef50c` |

## Observations for production

- The interim M5 behaviour makes a GoTrue deletion of a group owner fail
  with a generic 500. The app has no account-deletion feature, so only
  dashboard or admin deletions are affected; M11 replaces this.
- Locks: every migration takes brief ACCESS EXCLUSIVE locks on
  `expenses`, `expense_splits` and `groups` (DDL). VALIDATE scans are tiny
  at production's size. Expected unavailability is well under a second.
