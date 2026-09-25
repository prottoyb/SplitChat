# Phase 1 — Database & security hardening design

**Status:** Proposed — awaiting the Phase 1 design approval gate. Amended
after design review round 1 (see "Review resolutions", which take precedence).
**Scope:** design only. No migration has been written or applied; no live
database operation has been performed for Phase 1.
**Inputs:** `supabase/baseline/` (Phase 0, commit `cb2db08`), Phase 0 reviews,
operator product/data decisions (2026-09-26).

References: `Lnnn` = line in `supabase/baseline/public_schema.sql`;
`inv:nnn` = line in `supabase/baseline/catalog_inventory.txt`.
Findings: QS-1 cross-group expense move · QS-2 anon membership oracle ·
QS-3 split-sum bypass · QS-4 owner-deletion cascade · QS-5 blanket grants ·
QS-6 email enumeration · QS-7 remainder-cent order mismatch · AR-n architect.

Decisions are recorded as ADRs in `docs/ADR/` (0001–0007). This file is the
detailed plan; the ADRs hold the why.

---

## 0. Operator decisions (binding)

- Prod holds production-like data that must be preserved; no destructive or
  reset-based migrations.
- After baseline adoption, all schema/RLS/function changes come through
  reviewed migrations; no dashboard edits. History adoption (`repair`) needs
  separate execution approval.
- Historical ledger survives account deletion: no cascade from an auth
  account into groups, expenses, splits, settlements or activity.
- Ownership transferable to another active member. An owner cannot leave or
  delete their account while owning an active multi-member group. Sole-member
  group deletion is a separate explicit flow.
- AUD only; integer cents at the app/domain boundary; no multi-currency.
- Expense edit/delete: creator (while authorized in the group) and group
  owner; other members cannot; enforced server-side. Never broadened silently.
- Keep add-by-email (no invitation system), hardened: owner only, target must
  exist, no anonymous enumeration, minimal-leak errors.
- Docker is not a runtime requirement.
- Fix order: (1) expense group immutability, (2) anon access /
  SECURITY DEFINER / search_path / grants, (3) direct-write bypass of
  financial invariants, (4) owner-deletion cascade, (5) privileges,
  (6) server-side membership/authorization, (7) deterministic remainder
  allocation identical in frontend and DB.

## Current frontend contract (verified in `src/`)

- Direct writes: `groups` INSERT of `name, description, created_by`
  (`GroupsPage.tsx:121-127`, no read-back); `group_members` DELETE
  (`GroupDetailsPage.tsx:326-330` remove, `395-399` leave).
- RPCs: `add_group_member_by_email` (`GroupDetailsPage.tsx:248`),
  `create_equal_split_expense` (`AddExpensePage.tsx:344`).
- No UPDATEs anywhere; no expense edit/delete, group update/delete, profile
  update.
- Ownership read from `groups.created_by` (`GroupDetailsPage.tsx:308,385,470`,
  `GroupsPage.tsx:316`).
- Raw `error.message` shown to users (`GroupDetailsPage.tsx:262,338,407`,
  `AddExpensePage.tsx:363`); money summed as floats
  (`ExpenseDetailsPage.tsx:361,412-422`).

---

## A. Design decisions

### A1. Migration strategy — ADR-0001

`supabase/migrations/20260926000000_baseline_public_schema.sql` reproduces
prod **exactly as it is, flaws included**. It is never executed on prod; it is
only recorded as applied with
`supabase migration repair --status applied 20260926000000 --db-url <session pooler>`.
Every fix is a later, separate, forward-only migration.

Conversion from the dump:

- Drop L5/L1297 (`\restrict` psql meta-commands), L22-35 (`CREATE SCHEMA
  public`, owner, comment), L1089-1096 (schema ACL), L1233-1290 (platform
  default privileges), L631-633.
- Replace L10-20 with transaction-local settings only
  (`SET LOCAL check_function_bodies = false`,
  `SELECT set_config('search_path', '', true)`) so nothing leaks into later
  migrations in the same session. `check_function_bodies` must stay off
  because SQL functions (L523/542/595/616) precede the tables (L639-721).
- Append `CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR
  EACH ROW EXECUTE FUNCTION public.handle_new_user();` (inv:56).
- No `OR REPLACE` / `IF NOT EXISTS`: an accidental re-apply fails loudly and
  rolls back.
- Migration files contain no `BEGIN`/`COMMIT` and nothing that can't run in a
  single transaction (no `CONCURRENTLY`).

Proof: in the local harness, applying M0 and dumping `public` must equal the
baseline after normalisation, with every exclusion listed.

Tooling: Supabase CLI pinned to an exact version, used only with `--db-url`
(`migration list`, `migration repair`, `db push`) through the session pooler
(5432). Believed to need no Docker — verified in the dev rehearsal before
any prod use. Install method is an operator dependency decision (G3).
Fallback: `psql -1 -v ON_ERROR_STOP=1 -f` plus hand-written history rows,
only after observing the CLI's `supabase_migrations.schema_migrations`
layout on the dev project.

Rejected: fresh-only squashed init (prod stays hand-managed); declarative
schemas (still needs baseline + repair; diff gaps on policies/grants/auth
triggers); `db pull` (needs Docker, second prod connection, writes history
itself); home-grown runner/history table (diverges from Supabase tooling).

### A2. Server-side authorization matrix (end state) — ADR-0003/0004

Actors: **anon**; **Out** = authenticated non-member; **Mem** = active
member; **Own** = active owner; **Fmr** = former member (`left_at` set);
service_role bypasses RLS but not triggers/constraints.

| Object / action | anon | Out | Mem | Own | Fmr | Enforced by |
|---|---|---|---|---|---|---|
| profiles SELECT | ✗ | self | self + active peers | same | self + peers of groups still active in | RLS + `private.my_group_peer_ids()` |
| profiles UPDATE (`full_name`, `avatar_url` only) | ✗ | self | self | self | self | column grant + L1049 policy |
| profiles INSERT/DELETE | ✗ | ✗ | ✗ | ✗ | ✗ | no grant (trigger/lifecycle only) |
| groups SELECT | ✗ | ✗ | ✓ | ✓ | ✗ | RLS |
| groups INSERT (`name, description, created_by=self`) | ✗ | ✓ | ✓ | ✓ | ✓ | column grant + L1042 policy |
| groups UPDATE / DELETE direct | ✗ | ✗ | ✗ | ✗ | ✗ | revoked; delete via `delete_group` |
| group_members SELECT (active rows) | ✗ | ✗ | ✓ | ✓ | ✗ | RLS |
| group_members INSERT/UPDATE/DELETE direct | ✗ | ✗ | ✗ | ✗ | ✗ | revoked; RPCs only |
| expenses / expense_splits SELECT | ✗ | ✗ | ✓ | ✓ | ✗ | RLS |
| expenses / expense_splits direct writes | ✗ | ✗ | ✗ | ✗ | ✗ | revoked + triggers |
| `create_equal_split_expense_v2` | ✗ | ✗ | ✓ | ✓ | ✗ | RPC |
| `update_equal_split_expense` / `delete_expense` | ✗ | ✗ | own only | any in group | ✗ | RPC |
| `add_group_member_by_email` | ✗ | ✗ | ✗ | ✓ | ✗ | RPC (role check) |
| `remove_group_member` | ✗ | ✗ | ✗ | ✓ (not self) | ✗ | RPC |
| `leave_group` | ✗ | ✗ | ✓ | ✗ (transfer/delete) | ✗ | RPC + DB trigger |
| `transfer_group_ownership` | ✗ | ✗ | ✗ | ✓ → active member | ✗ | RPC + one-owner index |
| `delete_group` | ✗ | ✗ | ✗ | only if no other membership rows ever | ✗ | RPC |

No admin role in Phase 1 (G2). `private.is_active_owner_of` is the single
extension point if one is added later.

### A3. Expense/split write boundary — ADR-0002

Client writes to `expenses`/`expense_splits` only through SECURITY DEFINER
RPCs. Database backstops apply to every role (including service_role and
dashboard SQL):

1. BEFORE UPDATE guards: `expenses.id, group_id, created_by, created_at` and
   `expense_splits.expense_id, user_id` are immutable.
2. `DEFERRABLE INITIALLY DEFERRED` constraint triggers on `expense_splits`
   (AFTER INSERT/UPDATE/DELETE) and `expenses` (AFTER INSERT, UPDATE OF
   amount): at commit the expense has ≥1 split and
   `sum(share_amount) = amount`; skipped for expenses deleted in the same
   transaction.
3. BEFORE INSERT/UPDATE guard: payer and every split user have a
   `group_members` row (active or former) in the expense's group. RPCs
   additionally require *active* membership for new writes.
4. `expenses_split_type_check` (L672) narrowed to `'equal'` (NOT VALID, then
   VALIDATE).
5. `percentage` (L644) left as is (all NULL); deferred to a future split-types
   ADR.

Rejected: RLS-only (bypassed today; cannot express cross-row sums); RPC-only
without triggers (service_role/dashboard/future RPC bugs could corrupt the
ledger); materialised total column (duplicated state).

### A4. Membership history — ADR-0004

Soft leave on `group_members`: `left_at timestamptz NULL`,
`left_reason text CHECK (left_reason IN ('left','removed','account_deleted'))`,
`removed_by uuid NULL REFERENCES profiles`, CHECK
`role <> 'owner' OR left_at IS NULL`. PK `(group_id, user_id)` stays;
re-adding a former member reactivates the row (clears `left_*`,
`role='member'`, `joined_at=now()`); multi-stint history is left to the future
activity feature.

RLS: every read path requires **active** membership. Former members lose
all access to the group — the same as today after a delete, so nothing is
broadened. The `group_members` SELECT policy returns active rows only (member
lists unchanged). Historical rows stay valid via FKs to `profiles`. Showing
former members' names depends on G1; without approval the UI keeps its
"SplitChat member" fallback.

Rejected: status enum (redundant with `left_at`); separate history table or
surrogate-PK multi-stint rows (complexity with no Phase 1 need); hard delete
(today — loses history).

### A5. Ownership, account deletion, transfer — ADR-0004/0005

**Ownership:** `group_members.role` is the single source of truth. Partial
unique index `group_members_one_active_owner ON (group_id) WHERE
role='owner' AND left_at IS NULL`. `groups.created_by` becomes an immutable
creator-audit field (guard trigger; FK to `profiles(id) ON DELETE
RESTRICT`), no longer meaning ownership. Transfer demotes then promotes under
`FOR UPDATE` row locks.

**Account deletion (profile tombstones):**

1. Drop `profiles_id_fkey` (L927, CASCADE from `auth.users`).
2. `groups_created_by_fkey` (L919) and `group_members_user_id_fkey` (L911)
   re-pointed to `profiles(id) ON DELETE RESTRICT`.
3. `expenses_group_id_fkey` (L887) → RESTRICT;
   `expense_splits_expense_id_fkey` (L863) stays CASCADE (splits are part of
   their expense).
4. `profiles.deleted_at timestamptz`.
5. BEFORE DELETE trigger on `auth.users` →
   `private.handle_auth_user_deleting()` (SECURITY DEFINER, owner postgres):
   - active owner of a group with other active members → raise
     `owner_must_transfer` (deletion blocked, nothing changes);
   - otherwise all active memberships → `left_at=now()`,
     `left_reason='account_deleted'`; a sole owner is demoted to member and
     the group persists with no active members;
   - profile tombstoned: `full_name='Deleted user'`, `avatar_url=NULL`,
     `deleted_at=now()`;
   - ledger rows are never touched.

Leaving: an owner can never leave (`owner_must_transfer`, or `delete_group`
when sole member). Interim step (M5): L919 → RESTRICT immediately, blocking
owner deletion until M11 lands.

Caveats: GoTrue soft-delete (`shouldSoftDelete`) updates rather than deletes
and would bypass the trigger — hard delete is the supported path. See
coordinator amendment CA-2 about platform restrictions on the `auth` schema.

Rejected: keeping the `profiles` cascade with RESTRICT (anyone with history
could never delete their account); forbidding `auth.users` hard delete
(the dashboard "Delete user" does it anyway); a separate
`profiles.auth_user_id` (churns every identity join).

### A6. Grants and RLS — ADR-0003

- New schema `private`, **not exposed** by the Data API. USAGE only to
  `authenticated` (for RLS evaluation).
- Caller-scoped, argument-free RLS helpers (SECURITY DEFINER, STABLE,
  `search_path=''`, EXECUTE to `authenticated` only):
  `private.my_active_group_ids() setof uuid`,
  `private.my_group_peer_ids() setof uuid`,
  `private.my_owned_group_ids() setof uuid` (interim until M10).
- Internal, no grants: `private.is_active_member_of(uuid,uuid)`,
  `private.is_active_owner_of(uuid,uuid)`,
  `private.equal_split_cents(bigint, uuid[])`, all trigger functions.
- **No client-executable function takes an arbitrary user id** → the QS-2
  oracle class is removed.
- Set-based policy form: `group_id IN (SELECT private.my_active_group_ids())`;
  `(SELECT auth.uid())` always wrapped. Replaces per-row calls at L952-993,
  L1000-1007.
- Every function `search_path=''` with fully qualified names (fixes L181,
  L563, L618). Every `CREATE FUNCTION` followed by `REVOKE ALL … FROM PUBLIC,
  anon, authenticated` then explicit GRANT. Every new table: RLS on + explicit
  grants in the same migration.
- Default privileges:
  `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON
  TABLES, SEQUENCES, FUNCTIONS FROM anon, authenticated` and
  `ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM
  PUBLIC` (global form required). Residual: `supabase_admin` defaults
  (L1267-1290) likely unchangeable by postgres — covered by guard test S2.
- Target grants: `anon` — USAGE on `public` only. `authenticated` — SELECT on
  the five tables; `INSERT(name, description, created_by)` on `groups`;
  `UPDATE(full_name, avatar_url)` on `profiles`; EXECUTE on the listed RPCs.
  No TRUNCATE/REFERENCES/TRIGGER for anyone except service_role (unchanged
  platform role).

Rejected: helpers in `public` (exposed as RPCs — the QS-2 cause); revoking
grants without fixing default privileges (every future migration insecure by
default).

### A7. Money and RPC signatures — ADR-0006

Storage stays `numeric(12,2)` (a type change is destructive for no gain).
Add `expenses.amount_cents bigint GENERATED ALWAYS AS ((amount*100)::bigint)
STORED` and `expense_splits.share_cents` likewise. The frontend reads only
`*_cents` and sends only cents; formatting only at display (`formatCents`,
AUD). Max 999,999,999,999 cents < 2^53, JSON-safe.

**Error contract:** every RPC raises SQLSTATE `P0001` with a stable
snake_case code as the message. The frontend maps codes in
`src/lib/rpcErrors.ts` with a generic fallback and never shows raw
`error.message`.

All RPCs: `public`, SECURITY DEFINER, `search_path=''`, EXECUTE for
`authenticated` only, first raise `auth_required` if `auth.uid()` is null.

1. `create_equal_split_expense_v2(p_group_id uuid, p_description text,
   p_amount_cents bigint, p_expense_date date, p_paid_by uuid,
   p_participant_ids uuid[], p_notes text DEFAULT NULL) RETURNS uuid` —
   errors `not_found_or_forbidden`, `invalid_description` (blank/ >120),
   `invalid_amount` (null, ≤0, >999999999999), `invalid_date`,
   `invalid_payer` (not active member), `invalid_participants` (empty, null
   element, duplicate, non-active member), `amount_too_small_to_split`,
   `invalid_notes` (>500).
2. `update_equal_split_expense(p_expense_id uuid, p_expected_updated_at
   timestamptz, p_description text, p_amount_cents bigint, p_expense_date
   date, p_paid_by uuid, p_participant_ids uuid[], p_notes text DEFAULT NULL)
   RETURNS timestamptz` — locks `FOR UPDATE`; allowed for the creator who is
   still an active member, or the active owner; participants may be active
   members or existing participants of this expense; payer active or
   unchanged; replaces splits; sets `updated_by`. Errors as (1) plus
   `forbidden`, `stale_expense`.
3. `delete_expense(p_expense_id uuid, p_expected_updated_at timestamptz)
   RETURNS void` — same authorization; `not_found_or_forbidden`,
   `forbidden`, `stale_expense`.
4. `add_group_member_by_email(target_group_id uuid, target_email text)` —
   **see CA-1 for the return type.** Caller must be the active owner;
   per-caller rate limit (20/hour) in `private.member_add_attempts` (RLS on,
   no grants); target must exist in `auth.users` with
   `email_confirmed_at IS NOT NULL`, not deleted, profile not tombstoned;
   former members are reactivated. Outcomes: `not_found_or_forbidden`
   (group missing *or* caller not owner — indistinguishable),
   `invalid_email`, `rate_limited`, `member_not_added` (no account /
   unconfirmed / deleted — one outcome, no enumeration), `already_member`
   (only reveals users already visible to the owner), success.
5. `remove_group_member(p_group_id uuid, p_user_id uuid) RETURNS void` —
   owner only; `not_found_or_forbidden`, `cannot_remove_owner`,
   `member_not_found`; sets `left_reason='removed'`, `removed_by`.
6. `leave_group(p_group_id uuid) RETURNS void` — `not_found_or_forbidden`,
   `owner_must_transfer`.
7. `transfer_group_ownership(p_group_id uuid, p_new_owner_id uuid) RETURNS
   void` — `not_found_or_forbidden`, `invalid_new_owner` (self, not active,
   unknown).
8. `delete_group(p_group_id uuid) RETURNS void` —
   `not_found_or_forbidden`, `group_has_other_members` (any other membership
   row, active or former); deletes the group's expenses, memberships, group.

Legacy `create_equal_split_expense(numeric, …)` becomes a wrapper in M12
(checks 2 dp, dedupes as before, calls v2) and is dropped in M14 after the v2
frontend is deployed.

### A8. Canonical split ordering — ADR-0006

Rule: dedupe participants, **sort ascending by UUID** (client compares
lower-cased canonical strings; server compares `uuid` values — PostgreSQL's
bytewise UUID order equals lowercase-hex string order, and the hyphens sit at
fixed positions). Each share is `floor(total/n)`; the first `total % n`
participants in canonical order get +1 cent. Input order is irrelevant.

- DB: one pure function
  `private.equal_split_cents(p_total_cents bigint, p_participant_ids uuid[])
  RETURNS TABLE(user_id uuid, share_cents bigint)` (IMMUTABLE), used by every
  RPC.
- Client: `allocateEqualSplit(totalCents, participantIds) →
  {userId, shareCents}[]` in `src/lib/expenseSplit.ts`, replacing
  `calculateEqualSplit`; the preview looks up shares by user id, not array
  position (fixes QS-7 at `AddExpensePage.tsx:275-284`).
- Shared vectors `src/lib/fixtures/equal-split-vectors.json`
  (`{name, totalCents, participantIds, expected | error}`), consumed by
  Vitest and the DB test runner: 10000/3, 1/1, 101/2, 2/3 →
  `amount_too_small_to_split`, 999999999999/7, non-canonical input order,
  mixed-case ids, ids differing only in the last hex digit / first byte.

Rejected: input order (today; fragile, the QS-7 cause); `joined_at` order
(changes on rejoin, needs extra client data); payer-first (couples split to
payer, more complex).

---

## Coordinator amendments (for QA/Security review)

**CA-1 — Rate-limit counting must survive failures.** A PL/pgSQL function
that `RAISE`s rolls back its own writes, so an attempt row inserted before a
`member_not_added` exception would be discarded and failed probes would never
count toward the limit — the exact enumeration path the limit exists for.
Therefore `add_group_member_by_email` **returns** its non-authorization
outcomes instead of raising them:
`RETURNS TABLE(result text, added_user_id uuid, added_full_name text,
added_role text)` with `result IN ('added','already_member',
'member_not_added','rate_limited')`; only `auth_required`,
`not_found_or_forbidden` and `invalid_email` raise (they need no counting:
non-owners are rejected before any lookup). The attempt row is committed
for every owner call. The frontend change ships in the same PR (M9). Test S5
asserts that failed attempts count.

**CA-2 — `auth` schema trigger permission is unverified.** M11 needs a
BEFORE DELETE trigger on `auth.users`. The existing `on_auth_user_created`
(inv:56) shows postgres could create one when it was added, but Supabase has
since restricted changes to its managed schemas. This must be proven on the
dev rehearsal project (or confirmed in current Supabase documentation) before
M11 is proposed for prod. Fallback if it is not permitted: keep M5's RESTRICT
(owner deletion blocked), and route account deletion through an explicit
`request_account_deletion` RPC that performs the tombstone/ownership checks
before an operator deletes the auth user — to be designed only if needed.

## Review resolutions (design review round 1)

QA/Security design review: FAIL (DS-1, DS-2 HIGH). Senior Review: APPROVE WITH
CONDITIONS (SR-D1..SR-D4). Resolutions below amend §A–§F and take precedence
over any conflicting text elsewhere in this file.

**DS-1 (HIGH) — authorization-first ordering in every membership RPC.**
`add_group_member_by_email`, `remove_group_member`, `transfer_group_ownership`
and `delete_group` perform, as their first step after `auth_required`, a
single check "caller is the active owner of `p_group_id`" and raise
`not_found_or_forbidden` for *every* failure at that stage (group missing,
caller not a member, caller not owner), before reading or validating any
target argument (`p_user_id`, `p_new_owner_id`, `target_email`). Target-level
codes (`member_not_found`, `invalid_new_owner`, `cannot_remove_owner`,
`invalid_email`, add-by-email results) are reachable only by the owner.
`update_equal_split_expense` / `delete_expense` likewise resolve the expense
and check "caller is an active member of its group" first, returning
`not_found_or_forbidden` identically for a nonexistent expense and for one in
a group the caller cannot see. New test **S9 (differential oracle test)**:
for each of these RPCs, a non-owner / outsider caller supplying an existing
vs a nonexistent target id (and an existing vs nonexistent expense id)
receives byte-identical SQLSTATE and message.

**DS-2 (HIGH) — operator override for ownership release.** Without an admin
role, a user owning a multi-member group could block every deletion of their
account, including operator-initiated erasure. Add (M11) a procedure
`private.admin_release_ownership(p_user_id uuid) RETURNS TABLE(group_id uuid,
new_owner_id uuid)`: for every group where `p_user_id` is the active owner and
other active members exist, ownership transfers to the longest-standing active
member (earliest `joined_at`, tie-break lowest `user_id`) using the same
locked demote-then-promote path as `transfer_group_ownership`; it never
deletes data. Under the same `FOR UPDATE` lock and immediately before
promotion, it re-reads the chosen successor's membership and profile. If
the successor is no longer active or is being deleted, it tries the next
candidate. If none remain, it raises a clean `successor_no_longer_active`
error for that group rather than relying on the `owner_active` CHECK to
abort (DS-11). EXECUTE is revoked from PUBLIC and **granted to no role
other than its owner `postgres`**: not to `service_role` and not to any
client role (DS-13). The same applies to `prepare_account_deletion` if it
is ever introduced. Each use is therefore an operator action requiring its
own execution approval (F-W8). After it runs, the normal deletion trigger
succeeds. This satisfies "ownership transferred first" rather than bypassing
it. Tests L7 (release then delete succeeds, ledger intact, one active owner
per group) and S2 (no client EXECUTE on it).

**DS-3 (MEDIUM) — orphaned groups are an accepted, documented state.** When a
sole owner deletes their account, the group remains with zero active members:
retained to satisfy "ledger survives deletion", invisible to everyone under
RLS, and not actionable by any client RPC. This is intentional — no one else
has an interest in it except former members, who by policy have no access.
Test L3 is extended to assert that no RPC can act on the orphaned group and
that its ledger still balances. A cleanup/export path is future scope.

**DS-4 (MEDIUM) — `already_member` discloses no identity.** For
`result = 'already_member'`, `member_not_added` and `rate_limited`, the
identity columns (`added_user_id`, `added_full_name`, `added_role`) are
`NULL`; they are populated only for `added`. Test S5 asserts this.

**DS-5 (MEDIUM) — M11 is gated on CA-2.** M11 may not be proposed for any
prod apply until either (a) the dev rehearsal proves a BEFORE DELETE trigger
on `auth.users` can be created and fires under GoTrue deletion (allowed and
blocked paths, DS-6), or (b) the fallback below is designed in full and passes
QA/Security and Senior Review. Fallback outline, to be completed only if (a)
fails: keep M5's RESTRICT so no deletion can cascade; add
`private.prepare_account_deletion(p_user_id)` (operator-only, same grants as
`admin_release_ownership`) that performs the tombstone steps (release
ownership, mark memberships `account_deleted`, tombstone profile) and drops
nothing; re-point domain FKs to `profiles` so the subsequent `auth.users`
delete no longer references ledger rows; account deletion becomes an operator
procedure (prepare, then delete in the dashboard) instead of a trigger.

**DS-6 (MEDIUM) — rehearsal covers the blocked path.** The dev-project
rehearsal (§D) must exercise, against real GoTrue: an allowed deletion (trigger
fires, tombstone correct) **and** a blocked deletion (`owner_must_transfer`),
confirming the `auth.users` row, identities, sessions and refresh tokens are
left intact and the deletion is retryable after ownership transfer.

**DS-7 (MEDIUM) — §F additions.** See F-W7, F-W8, F-W9 in §F.

**DS-8 (MEDIUM) — positive-target runner guard.** `scripts/db-test.mjs` must
not rely on a denylist. It:
- starts every subprocess with an environment built from scratch: all `PG*`
  variables removed, and `PGSERVICEFILE` / `PGPASSFILE` pointed at nonexistent
  paths inside its temp dir. It never reads `DB_URL`, `DATABASE_URL`,
  `SUPABASE_DB_URL` or `.env*`;
- passes an explicit connection string it built itself
  (`host=127.0.0.1 port=<its port> dbname=… user=…`) as an argument to every
  `psql`/`pg_dump` call;
- after connecting, before running any SQL file, asserts
  `inet_server_addr()` is loopback, `current_setting('port')` equals its port,
  and `system_identifier` from `pg_control_system()` equals the one it recorded
  right after `initdb`; it aborts on any mismatch;
- has a self-test that launches it with spoofed `PGHOST`, `PGSERVICE`,
  `DATABASE_URL` and `DB_URL` values and asserts it still only touches its own
  cluster.

**DS-9 (LOW) — explicit gaps.** Group rename/description edit is **not** in
Phase 1: the frontend has no such feature, and direct `groups` UPDATE is
revoked in M6. Group deletion is unavailable from M6 until M15; the frontend
has no group-delete feature today, so no behaviour is lost.

**DS-10 (OPTIONAL) — timing side-channels** in the membership RPCs are
accepted for this threat model (owner-only, rate-limited) and not mitigated.

**SR-D1** — M16 is marked optional scope (§B); operator decision requested.
**SR-D2** — M8 drop-and-recreate rationale added (§B).
**SR-D3** — `docs/phase-state.md` now lists open questions and review status.
**SR-D4** — design approval does not resolve G1–G5; each still needs its own
answer before the operations it blocks.

**CA-3 — Generated cents columns are exact.** `(amount*100)::bigint` is
exact because `numeric(12,2)` guarantees scale 2; the cast never rounds
real data. Test F10 asserts it.

---

## B. Migration sequence

Timestamps assigned at creation, strictly after `20260926000000`. Every
migration is SENSITIVE and each live apply needs its own execution approval
(§F). Each ships a tested `supabase/rollbacks/<ts>_<slug>.down.sql`
(up → down → up locally); in prod a rollback is applied as a new forward
migration so history stays linear.

Post-migration verification for every migration: full harness suite passes;
in prod, a re-dump of `public` (normalised) must equal the harness dump after
the same migration, plus a read-only catalog check (privilege matrix,
policies, triggers, constraints).

"Destructive" = drops table/column or deletes/transforms data
(`database.md`); "removes surface" = drops policies/functions/grants/indexes.

| # | Slug | Purpose / findings | Objects affected | Destructive / removes surface | Pre-checks (read-only, counts only) | Rollback |
|---|---|---|---|---|---|---|
| M0 | `baseline_public_schema` | AR-1 | all of L39-1230 + auth trigger | no / no — never executed on prod; recorded by `repair` | drift check vs Phase 0 | n/a; round-trip diff proof |
| M1 | `guard_expense_immutable_columns` | P1, QS-1 | `CREATE SCHEMA private` (no grants); `private.guard_expense_immutables()` + `expenses_guard_immutables` BEFORE UPDATE; `private.guard_split_immutables()` + trigger on `expense_splits` | no / no | Q1–Q3: splits / payers / creators without a membership row in the expense's group (forensics for past moves; may also reflect earlier leave-deletes) | drop triggers + functions |
| M2 | `revoke_anon_harden_definer_functions` | P2, QS-2, AR-9 | REVOKE EXECUTE from anon/PUBLIC on `split_chat_is_group_member` (L1185), `create_equal_split_expense` (L1113); `search_path=''` on those + `set_expenses_updated_at`; revoke EXECUTE on trigger functions from PUBLIC/anon/authenticated (L1130-1132, L1157-1168) | no / no (residual: authenticated can still call the oracle until M8 — needed by L936-993) | none | re-grant (recovery only) |
| M3 | `revoke_direct_ledger_writes` | P3, QS-3, QS-1 | REVOKE INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on `expenses`, `expense_splits` from anon + authenticated; SELECT from anon; DROP POLICY L934, L943, L952, L959, L970, L977 | no / yes | none (frontend writes neither table) | recreate policies from baseline + re-grant |
| M4 | `enforce_ledger_invariants` | P3, AR-2, AR-10 | `private.assert_expense_balanced(uuid)`; constraint triggers `expense_splits_balanced`, `expenses_balanced`; `private.guard_ledger_membership()`; `split_type` CHECK → `'equal'` | no / no | Q4 unbalanced expenses; Q5 expenses with no splits; Q6 `split_type` counts; Q7 non-null `percentage`. **Q4, Q5 and non-equal Q6 must be 0, else stop for a separately approved data fix** | drop triggers; restore L672 CHECK |
| M5 | `restrict_owner_deletion_cascade` | P4 interim, QS-4 | `groups_created_by_fkey` → ON DELETE RESTRICT (NOT VALID → VALIDATE) | no / no | Q8 groups whose `created_by` has no auth user (must be 0) | restore CASCADE (not advised) |
| CP | *urgent security batch M1–M5 complete* | | | | | |
| M6 | `least_privilege_grants` | P5, QS-5, AR-4 | revoke ALL on `profiles` from anon (L1228); revoke TRUNCATE/REFERENCES/TRIGGER on all tables from authenticated; `groups`: revoke INSERT/UPDATE/DELETE, grant `INSERT(name, description, created_by)`; `profiles`: revoke INSERT/UPDATE/DELETE, grant `UPDATE(full_name, avatar_url)`; `group_members`: revoke INSERT/UPDATE (DELETE kept until M10); DROP POLICY L1014, L1021, L1035; default privileges per A6 | no / yes | confirm prod grants still equal the baseline (catalog) | re-grant + recreate policies |
| M7 | `membership_lifecycle_and_single_owner` | P6, AR-5 | `group_members.left_at`, `left_reason`, `removed_by`, CHECK `owner_active`; index `group_members_one_active_owner`; `private.guard_group_immutables()` (`id`, `created_by`, `created_at`) | no / no | Q9 groups whose owner-row count ≠ 1; Q10 owner rows whose `user_id` ≠ `groups.created_by` — both must be 0 | drop index/CHECK/trigger; drop new columns only while all NULL |
| M8 | `private_helpers_rls_rewrite` | P6, QS-2 final, AR-8/9 | USAGE on `private` to authenticated; `my_*` helpers, `is_active_member_of/owner_of`; rewrite every SELECT policy in set form (active-only `group_members`); interim `group_members` DELETE policy (L1028) via `my_owned_group_ids`; move `set_updated_at`, `handle_new_group`, `handle_new_user` to `private` and recreate the 4 public triggers + `on_auth_user_created`; `create_equal_split_expense` uses `private.is_active_member_of`; DROP FUNCTION `public.split_chat_is_group_member`, `is_group_member`, `is_group_owner`, `shares_group_with`, `set_expenses_updated_at`, `set_updated_at`, `handle_new_group`, `handle_new_user` | no / yes | none | recreate from baseline text (recovery only) |
| M9 | `membership_rpcs` | P6, QS-6 | `add_group_member_by_email` rewritten (A7-4 + CA-1); `private.member_add_attempts`; `remove_group_member`, `leave_group`, `transfer_group_ownership`; **frontend in the same PR** | no / no | none | restore old body; drop new functions + disposable table |
| M10 | `revoke_direct_membership_delete` | P5/6 | revoke DELETE on `group_members` from authenticated; drop L1028 policy + `private.my_owned_group_ids`; **only after M9 frontend is deployed** | no / yes | none | re-grant + recreate policy |
| CP | *privilege & membership batch M6–M10 complete* | | | | | |
| M11 | `ledger_preserving_account_deletion` | P4 final, AR-3 | `profiles.deleted_at`; backfill missing profiles from `auth.users` (additive INSERT); `group_members.user_id`, `groups.created_by` FKs → `profiles` (NOT VALID → VALIDATE → drop old); DROP `profiles_id_fkey`; `expenses_group_id_fkey` → RESTRICT; `private.handle_auth_user_deleting()` + `on_auth_user_deleting` BEFORE DELETE ON `auth.users` (**CA-2 / DS-5 gate**); `private.admin_release_ownership(uuid)` (postgres-only EXECUTE, DS-2) | additive data write / yes (FK) | Q11 memberships without a profile; Q12 same for `groups.created_by`, `expenses.paid_by/created_by`; Q13 profiles without an auth user (expect 0) | drop trigger and `admin_release_ownership`, restore FKs — **not fully reversible once any account has been deleted** (re-adding `profiles_id_fkey` would need NOT VALID) |
| M12 | `money_cents_and_canonical_split` | P7, QS-7, AR-6/7 | generated `amount_cents`, `share_cents` (table rewrite, brief exclusive lock); `private.equal_split_cents`; `create_equal_split_expense_v2`; legacy RPC → wrapper; **frontend in the same PR** | no / no | Q14 `max(amount)` sanity | drop v2/function, restore legacy body; columns only after frontend rollback |
| M13 | `expense_update_delete_rpcs` | operator edit/delete rules | `expenses.updated_by uuid NULL REFERENCES profiles`; `update_equal_split_expense`, `delete_expense` | no / no | none | drop functions (+ column while all NULL) |
| M14 | `drop_legacy_expense_rpc` | tidy-up | DROP FUNCTION `public.create_equal_split_expense(uuid,text,numeric,date,uuid,uuid[],text)`; **only after v2 frontend is deployed** | no / yes | none | recreate wrapper |
| M15 | `delete_group_rpc` | sole-member group deletion flow | `delete_group` | no at migration time (user-invoked deletion at runtime) / no | none | drop function |
| M16 | `index_cleanup` | AR-13, AR-8 | DROP INDEX `expense_splits_expense_id_idx` (L778); CREATE INDEX `expenses_group_date_idx (group_id, expense_date DESC, created_at DESC)`; `group_members_active_user_idx (user_id) WHERE left_at IS NULL` | no / yes | Q15 `idx_scan` of L778 index | recreate index |
| CP | *Phase 1 schema complete* | | | | | |

**M16 is optional scope.** It is performance/tidiness, not one of the
operator's seven hardening items; it is separable (own PR8/CP17) and included
only if the operator explicitly places it in Phase 1 (otherwise deferred).

**M8 drops and recreates functions deliberately** (rather than
`ALTER FUNCTION … SET SCHEMA private`): every body is rewritten anyway
(`search_path=''`, fully qualified names, active-membership semantics), and a
new function has a new OID, so the dependent triggers (4 in `public` plus
`on_auth_user_created`) are dropped and recreated explicitly in the same
migration. Test S8 proves they still fire.

Dependencies: M1–M5 independent; M8 needs M6+M7; M9 needs M8; M10 needs M9
deployed; M11 needs M7; M12 needs M8; M13 needs M4+M12; M14 needs M12
deployed. All migrations are small, single-transaction, brief locks.

Proposed PRs: PR1 harness + M0 · PR2 M1–M5 · PR3 M6–M8 · PR4 M9 + frontend,
then M10 · PR5 M11 · PR6 M12 + frontend, then M14 · PR7 M13, M15 · PR8 M16.

---

## C. Test plan

**Harness:** plain SQL assertion scripts (no pgTAP dependency). Test-only
schema `tests` (never in migrations): `tests.assert(bool, text)`,
`tests.assert_eq(anyelement, anyelement, text)`,
`tests.assert_raises(sql text, sqlstate text, msg_code text)`,
`tests.login(uuid)` / `tests.logout()` setting `request.jwt.claims` via
`set_config(…, true)`. Each case: `BEGIN; SELECT tests.login(...); SET LOCAL
ROLE authenticated; …; ROLLBACK;` under `psql -v ON_ERROR_STOP=1`; deferred
constraints tested with `SET CONSTRAINTS ALL IMMEDIATE`.

**Fixtures** (`tests/db/fixtures/seed.sql`): A owner of G1, B member of G1,
C outsider (member of G2), D owner of G2, E former member of G1 (after M7),
one unconfirmed-email user; G1 expenses with remainder splits including E.

**Characterisation first (PR1):** tests assert today's behaviour, including
the known-bad (anon can execute the oracle; owner cascade deletes expenses).
Each remediation PR flips its assertions — these are the regression tests
required by `testing.md`.

**Security**
- S1 anon: every table × {SELECT, INSERT, UPDATE, DELETE} → `42501`;
  catalog sweep: no function in `public`/`private` executable by anon.
- S2 structural guard (every migration): every `public` table has RLS; no
  anon ACL on `public`/`private` objects; authenticated has no
  TRUNCATE/REFERENCES/TRIGGER; postgres default ACL in `public` grants
  nothing to anon/authenticated; every SECURITY DEFINER function has
  `search_path=""` and owner postgres; authenticated EXECUTE set on `public`
  functions equals an allowlist; `private` not exposed (config + manual prod
  check).
- S3 cross-group: outsider C sees 0 rows of G1 in every table and A's
  profile; every RPC on G1 → `not_found_or_forbidden`; member B →
  `not_found_or_forbidden` on add/remove/transfer and `forbidden` editing A's
  expense.
- S4 immutability: `UPDATE expenses SET group_id` fails as authenticated
  (`42501`) and as postgres/service_role (guard); split `expense_id/user_id`
  and `groups.created_by` updates fail.
- S5 enumeration: owner adding nonexistent / unconfirmed / tombstoned email
  → identical `member_not_added`; non-owner → `not_found_or_forbidden` for
  existing and nonexistent emails alike; failed attempts are counted and the
  21st in an hour → `rate_limited` (CA-1).
- S6 former member E: no G1 visibility; v2 → `not_found_or_forbidden`; E's
  historical splits remain visible to A/B and the expense still balances.
- S7 column grants: updating `profiles.deleted_at`/`id` fails; `INSERT INTO
  groups(created_at, …)` fails; `created_by` ≠ self fails (RLS).
- S8 triggers still fire after EXECUTE revocation and the move to `private`
  (`updated_at`, owner row on group insert, profile on `auth.users` insert).
- S9 differential oracle test (DS-1): for `add_group_member_by_email`,
  `remove_group_member`, `transfer_group_ownership`, `delete_group`,
  `update_equal_split_expense`, `delete_expense`, a non-owner/outsider caller
  supplying an existing vs nonexistent target id (or expense id) receives
  byte-identical SQLSTATE and message.
- S10 `admin_release_ownership`: no EXECUTE for anon, authenticated or
  service_role; callable only as postgres (DS-13).

**RLS matrix:** one test per cell of A2 — 5 tables × 4 actions ×
{anon, Out, Mem, Own, Fmr}, asserting row counts or SQLSTATE.

**Financial integrity**
- F1 shared vectors against `private.equal_split_cents` and end-to-end via v2
  (resulting splits in UUID order).
- F2 unbalanced split insert as postgres fails at `SET CONSTRAINTS ALL
  IMMEDIATE`. F3 expense with 0 splits fails. F4 changing `amount` without
  splits fails. F5 deleting an expense cascades splits without the sum check
  firing. F6 split user/payer without a membership row rejected.
  F7 `split_type='exact'` rejected.
- F8 v2 input validation, one case per error code.
- F9 update/delete: active creator ✓; creator after leaving →
  `not_found_or_forbidden`; owner editing another's expense ✓; member →
  `forbidden`; wrong `p_expected_updated_at` → `stale_expense`; former-member
  participants preserved on edit.
- F10 `amount_cents = amount*100`; `share_cents` sum = `amount_cents`.
- F11 legacy wrapper produces the same splits as v2.

**Lifecycle** (deletions run as `supabase_auth_admin` in the shim)
- L1 delete member B: profile tombstoned, memberships `account_deleted`,
  ledger intact, FKs valid.
- L2 delete owner A with other active members → `owner_must_transfer`,
  nothing changed.
- L3 delete sole owner: allowed; group persists with 0 active members; no
  RPC can act on the orphaned group; its ledger still balances (DS-3).
- L4 transfer: happy path, invalid targets, non-owner caller, one-owner
  index, concurrent transfers serialised.
- L5 owner `leave_group` → `owner_must_transfer`; member leaves; re-add
  reactivates the row.
- L6 `delete_group` refused when any other membership row exists.
- L7 `admin_release_ownership` then delete (DS-2): ownership moves to the
  longest-standing active member, the deletion then succeeds, the ledger is
  intact, and each group has exactly one active owner. With the chosen
  successor deleted or leaving concurrently, it falls back to the next
  candidate, or raises `successor_no_longer_active` if none remain (DS-11).

**Frontend (Vitest)**
- `expenseSplit.ts`: `allocateEqualSplit` + `expenseSplit.vectors.test.ts`
  reading the shared JSON.
- `money.ts`: `formatCents`; remove float paths.
- `rpcErrors.ts` + tests: every code mapped; unknown → generic; raw messages
  never shown.
- `AddExpensePage.test.tsx`: calls v2 with integer `p_amount_cents`; preview
  gives the extra cent to the canonically first id regardless of toggle
  order; error codes mapped.
- `GroupDetailsPage.test.tsx` (new): owner from membership role; remove/leave
  call RPCs; `owner_must_transfer` handled; no direct `group_members` delete;
  add-member `result` outcomes rendered (CA-1).
- `GroupsPage` owner badge from the caller's membership role; expense pages
  read `*_cents` and total by integer sum; `supabaseMock.ts` gains `is` and
  per-RPC results.

**Runner** `scripts/db-test.mjs` (Node only, no new dependencies), exposed as
`npm run test:db`:

1. Refuses if `PGHOST`/`DATABASE_URL` point anywhere but localhost or the
   runner's own port.
2. `initdb -U cluster_admin` into a temp dir, port 54329,
   `listen_addresses=localhost`; `pg_ctl start`.
3. Load the shim as `cluster_admin`.
4. Apply `supabase/migrations/*.sql` in order as `postgres` with `psql -1`.
5. Load seed; generate vectors SQL from the JSON (dollar-quoted).
6. Run `tests/db/cases/*.sql`.
7. Optional: round-trip dump/diff (M0) or export an expected dump for prod
   comparison.
8. Stop the cluster and delete the temp dir.

---

## D. Test environment — ADR-0007

| | (1) Supabase cloud dev/test project | (2) Local Supabase stack | (3) Throwaway local PG17 + shim | (4) WSL PG17 + pgTAP + shim |
|---|---|---|---|---|
| Fidelity | Highest: real GoTrue delete path, PostgREST, platform roles/default privileges | High | Medium: roles, RLS, grants, triggers, `auth.uid()`. **Not:** PostgREST error mapping, GoTrue delete call, platform-managed grants beyond the shim | as (3) |
| Safety | Separate credentials; risk of pointing at prod (runner guard) | isolated | isolated, no network | isolated |
| Cost | Free tier (pauses when idle); new infrastructure needs approval | free | free | free |
| Setup | create project; CLI `--db-url` | **Docker required — not available**, conflicts with operator constraint | PG17 already installed; shim ≈ 1 h | apt install in WSL |
| CI-ready | yes (secrets) | yes with Docker | yes, any runner with PG17 | yes |
| Docker | none | required | none | none |

**Shim** (`tests/db/shim/00_supabase_shim.sql`, test-only, mirrors
inv:161-175): roles `cluster_admin` (initdb superuser); `postgres` LOGIN,
non-superuser, BYPASSRLS, CREATEROLE, CREATEDB, database owner (so migrations
hit the same privilege errors as prod); `anon`, `authenticated` NOLOGIN;
`service_role` NOLOGIN BYPASSRLS; `authenticator` LOGIN NOINHERIT member of
the three; `supabase_admin`, `supabase_auth_admin`. Schema `auth` owned by
`supabase_auth_admin` with `auth.users(id uuid pk, email text,
raw_user_meta_data jsonb, email_confirmed_at timestamptz, deleted_at
timestamptz, created_at timestamptz)`; postgres gets SELECT, REFERENCES,
TRIGGER on it. `auth.uid()` per Supabase's definition
(`request.jwt.claim.sub`, falling back to `request.jwt.claims->>'sub'`),
`auth.role()`, `auth.jwt()`. Schema `extensions`. `public` USAGE as
L1093-1096. Platform default privileges from L1237-1290 (including
supabase_admin), created by `cluster_admin`. A shim self-test asserts role
attributes match the inventory.

**Recommendation:**

- **(3) is the required gate** for every migration and PR: fast,
  deterministic, cannot touch prod, no Docker, uses the PG17 already
  installed.
- **(1) is the pre-prod rehearsal** for each prod batch, if the operator
  approves creating it (G4): M0 as a fresh init on real Supabase (proves the
  conversion), CLI `db push`/`repair` without Docker, observe
  `schema_migrations`, a GoTrue deletion firing M11's trigger (CA-2), and a
  frontend smoke test via `.env.development.local` against PostgREST.
- (4) only if CI later needs pgTAP. (2) not recommended now; revisit only if
  Docker is adopted for development.
- No CI exists (`.github` absent): a documented, tracked risk. The runner is
  CI-ready unchanged.

---

## E. Checkpoint commits (local, `feature/phase1-db-hardening`)

- **CP0** phase-state file + this design + ADR 0001–0007 (drafts).
- **CP1** harness: runner, shim + self-test, `tests` helpers, seed.
- **CP2** M0 + round-trip diff evidence + characterisation tests (PR1 ready).
- **CP3–CP7** M1…M5, each with `.down.sql` and flipped tests; **CP7b** PR2
  ready.
- **CP8–CP10** M6, M7, M8 (PR3 ready).
- **CP11** M9 + frontend membership/rpcErrors + Vitest; **CP12** M10 (PR4).
- **CP13** M11 + lifecycle tests (PR5).
- **CP14** M12 + frontend cents/canonical ordering + vectors; **CP15** M14
  (PR6).
- **CP16** M13, M15 (PR7). **CP17** M16 (PR8).
- **CP18** docs/README, full lint/build/test/test:db, PR preparation.

Plus a phase-state update ("awaiting approval: <operation>") before every
live operation in §F.

Each checkpoint is taken only after lint, build, `npm test` (and
`npm run test:db` once it exists) pass, and records the results in
`docs/phase-state.md`.

---

## F. Live operations requiring separate execution approval

Each needs its own explicit approval **immediately before** it runs
(`CLAUDE.md` Human Approval; Mandatory Gate #5 for writes).

**Read-only**

- F-R1 drift check: guarded read-only re-capture diffed against Phase 0 —
  before `repair` and before each apply batch.
- F-R2 per-migration data checks Q1–Q15 (aggregate counts only), each
  immediately before its migration.
- F-R3 `supabase migration list --db-url` before/after `repair`.
- F-R4 post-apply verification: re-dump + catalog check vs the harness
  expected dump.
- F-R5 dashboard confirmation that the Data API does not expose `private`,
  and recording of Auth settings for config (Phase 0 C3).

**Writes**

- F-W1 `supabase migration repair --status applied 20260926000000` — creates
  `supabase_migrations` and one history row; does not change `public`.
- F-W2 each `db push` of M1…M16, **one migration per approval**. Extra care:
  surface removal in M3, M6, M8, M10, M11, M14, M16; M11 also writes data
  (profile backfill) and adds an `auth.users` trigger; M12 rewrites tables
  under a lock.
- F-W3 any data fix if a pre-check fails (Q4/Q5/Q6/Q9/Q10/Q11–Q12) — a
  separately approved migration; money is never auto-corrected.
- F-W4 ordered frontend deployments: M9 frontend before M10; M12 frontend
  before M14.
- F-W5 creating the Supabase dev project (new infrastructure) and applying
  migrations to it — not prod, but a shared environment.
- F-W6 credential handover: the operator supplies the session-pooler URL
  per session; never written to a file.

- F-W7 applying a **rollback-as-forward-migration** in prod (incident or
  planned) — its own approval, never implied by the original migration's
  approval.
- F-W8 each invocation of `private.admin_release_ownership` (or, under the
  DS-5 fallback, `private.prepare_account_deletion`) in prod — an operator
  action on a named user.
- F-W9 exercising GoTrue account deletion (allowed and blocked paths) on the
  dev rehearsal project — distinct from applying migrations there (F-W5).

Not needed: Auth setting changes; prod smoke tests that create data (use the
dev project, or the operator's own account only with explicit approval).

Other gated items that are not live operations: installing the Supabase CLI
(dependency, G3 — `npm audit`/security rules apply); pushing branches;
opening/merging PRs.

---

## G. Open questions

Blocking parts of the design:

- **G1** Should active members see former members' profiles (name/avatar)
  in shared groups so history displays names? This *broadens* profile
  visibility, so it is excluded unless approved. Blocks the final
  `my_group_peer_ids` definition in M8. Without it: "SplitChat member"
  fallback.
- **G2** Admin role in Phase 1? Design assumes owner only with a single
  extension point. Blocks M7 CHECK and M9/M13 authorization.
- **G3** Supabase CLI install method (pinned devDependency vs pinned binary).
  Blocks F-W1/F-W2.
- **G4** Approve a Supabase cloud dev project for rehearsal? Without it, prod
  applies rely on harness evidence only and M11's GoTrue path (CA-2) stays
  unproven against the real auth service.
- **G5** Frontend hosting and deploy process — blocks the M10/M14 ordering.

Non-blocking defaults assumed: rate limit 20/hour; former members have no
read access; `joined_at` resets on re-add; no "manual expense" flag until
non-manual expenses exist.

Unverified assumptions (each covered by a test or the rehearsal): CLI
`db push`/`repair` work without Docker; EXECUTE is not checked when a trigger
fires (S8); postgres cannot alter supabase_admin default privileges; triggers
on `auth.users` are still permitted (CA-2).
