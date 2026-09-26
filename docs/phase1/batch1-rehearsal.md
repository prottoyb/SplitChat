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

## Round 2: review conditions resolved

Reviews of round 1 found no CRITICAL or HIGH issues: QA/Security PASS,
Senior APPROVE WITH CONDITIONS. Their conditions were addressed as follows.

| Finding | Resolution | Evidence |
|---|---|---|
| R1-SR-1: drift check against production immediately before repair | `prod.mjs preflight` dumps live production and requires an **exact** match with the Phase 0 capture, aborting otherwise | Dress rehearsal: the gate aborted on SplitChat-Dev, whose ACL entry order had changed after the rollback reset (identical when ACL order is ignored). The gate is strict. |
| R1-SR-2 / R1-QS-2: prove production has no migration history | preflight requires both no `supabase_migrations` table and an empty remote `migration list`; `repair-m0` refuses if history exists; `push` refuses unless the remote history is exactly `[M0]` | Dress rehearsal: a second `push` was refused |
| R1-SR-3: behaviour on a mid-batch failure | Rehearsed on SplitChat-Dev with throwaway probe migrations (see below) | Each file is its own transaction; a failing file is atomic; the push stops at the first failure; re-push after a fix applies only the remainder |
| R1-QS-1: lock contention | preflight lock check (`supabase/ops/lock_check.sql`); a monitored apply (below). Connection-level `lock_timeout` is impossible because the pooler drops startup options (tested: it read back `0`) | Lock check passes on dev (0/0) |
| R1-SR-4 / R1-QS-4: password in argv, `shell:true` | The password now travels only as `PGPASSWORD`; URLs are password-free; the pinned CLI runs as `node node_modules/supabase/dist/supabase.js` with no shell | The CLI with a password-free `--db-url` works (tested) |
| R1-QS-3: scrub every `SUPABASE_*` variable | `FORBIDDEN_ENV` now covers `SUPABASE_.*` | Lint and harness pass |
| R1-QS-5: sentinel role | Documented: the ref check is the primary control, the sentinel is defence in depth | n/a |

### Mid-batch failure rehearsal (SplitChat-Dev, throwaway copy of the migrations dir)

- **T1 (valid):** committed and recorded. Inside it, `SET LOCAL
  lock_timeout = '1234ms'` read back `1234ms`, which proves the CLI wraps
  each file in a transaction.
- **T2 (a valid INSERT, then an error):** push failed (42P01). T2's INSERT
  was **rolled back** and T2 was **not recorded**.
- **T3:** not attempted; the push stops at the first failure.
- **Recovery:** fixing T2 and pushing again applied only T2 and T3.
- **Cleanup:** probe history was reverted with `migration repair --status
  reverted` and the probe table dropped. SplitChat-Dev returned exactly to
  the post-M5 schema (17/17 post-checks, identical to the harness).

**Production recovery rule.** If file *k* fails, M1…M(k−1) remain applied
and recorded, and M*k* leaves nothing behind. Stop and diagnose. Then
either fix forward with a new reviewed migration, or apply the reviewed
rollbacks for the applied files (each is a separate approved operation).
Never edit an applied file.

### Rollback path on real Supabase

To dress-rehearse the production tool, SplitChat-Dev was reset to the
production baseline by applying the five reviewed rollbacks
(M5 → M1, all succeeded) and dropping its history schema. The rollbacks are
therefore proven on real Supabase, not only in the local harness.

### Dress rehearsal of the exact production tool (`scripts/ops/prod.mjs --rehearse-on-dev`)

| Step | Result |
|---|---|
| `preflight` | Target, history, Q4/5/6/8 and lock gates PASS. The drift gate ABORTED (ACL-order artifact of the reset, see above). In production any ABORT stops the procedure |
| `repair-m0` without `SPLITCHAT_PROD_APPROVAL` | refused |
| `repair-m0` with approval | M0 recorded |
| `dry-run` | exactly M1–M5 |
| `push` with approval | M1–M5 applied |
| `push` again | refused (history is no longer `[M0]`) |
| `verify` | history = M0..M5; post-checks 17/17; ledger unchanged; schema == harness post-M5. **VERIFY PASSED** |

The production-only guards (the prod-ref check, refusal of the dev URL and
of the transaction pooler port) were tested separately and refuse as
designed.

## Round 3: tooling review follow-ups (QA/Security PASS, Senior APPROVE WITH CONDITIONS, no CRITICAL/HIGH)

| Finding | Resolution |
|---|---|
| R2-SR-1: the drift check could go stale between `preflight` and `repair-m0` | `repair-m0` now re-runs the **exact** drift check itself immediately before writing, and refuses on any difference |
| R2-QS-1: gap between the manifest check and the CLI reading `supabase/migrations` | Writes copy the migrations into a private `mkdtemp` staging directory, verify the **copies** (read-only), and run the CLI with `--workdir` on that copy |
| R2-QS-3 / R2-SR-2: truncated hashes | Full 64-hex SHA-256 manifest |
| R2-SR-3: predictable temp file | `mkdtemp` directory plus exclusive create |
| R2-QS-2: post-checks counted, not named | `verify` requires every check **name** from `batch1_postchecks.sql` to be `t` |
| R2-SR (runbook): `verify` took an operator-supplied schema path | The expected post-M5 schema is committed as `supabase/ops/batch1_expected_schema.sql`, pinned by SHA-256 in the tool |
| R2-QS-4: negative tests reached real infrastructure | During the round-2 review, one negative test by the QA agent used the production ref with a realistic pooler host and a dummy password. That made one outbound connection attempt, which failed at authentication; no access occurred. Guidance is now in the tool header: negative tests use a dev ref or a wrong port only |

### Dress rehearsal 2: revised `prod.mjs --rehearse-on-dev`, clean

SplitChat-Dev was reset exactly to the production baseline (the reviewed
rollbacks, then M0's privilege section to restore ACL order). An **exact**
comparison with the Phase 0 capture: IDENTICAL.

| Step | Result |
|---|---|
| `preflight` | **all 6 gates PASS** (exact drift, empty history, Q-gates, locks 0/0) |
| `push` before repair | refused (history is not `[M0]`) |
| `repair-m0` without approval | refused |
| `repair-m0` with approval | M0 recorded (the drift check ran again inside the command) |
| `repair-m0` again | refused (history exists) |
| `dry-run` | exactly M1–M5 |
| `push` with approval | M1–M5 applied from the verified staging copy |
| `push` again | refused |
| `verify` | history M0..M5; **17/17 named post-checks**; ledger unchanged; schema == committed expected schema. **VERIFY PASSED** |
| Tampered M1 / extra migration file | both refused before any CLI call |

## Observations for production

- The interim M5 behaviour makes a GoTrue deletion of a group owner fail
  with a generic 500. The app has no account-deletion feature, so only
  dashboard or admin deletions are affected; M11 replaces this.
- Locks: every migration takes brief ACCESS EXCLUSIVE locks on
  `expenses`, `expense_splits` and `groups` (DDL). VALIDATE scans are tiny
  at production's size. Expected unavailability is well under a second.
- Lock policy for batch 1: the batch 1 files stay exactly as reviewed and
  rehearsed, so no in-file `lock_timeout`. Instead:
  - the preflight lock check must be 0/0 immediately before `push`;
  - the push is watched;
  - if any file waits on a lock for more than 10 s, the operator cancels
    it (`pg_cancel_backend`, itself a separately approved action). That
    file rolls back atomically, as proven above, and the push is retried
    later.
  - **From M6 onward, every migration begins with
    `SET LOCAL lock_timeout = '5s';`** (proven to work, since each file is
    its own transaction).
