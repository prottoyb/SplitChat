# ADR-0009: Activity model for the dashboard and activity feed

**Status:** Proposed 2026-09-27 (Phase 3). If the decision is a persisted
event model (option C), implementation waits for operator approval
(programme rule: a persisted event model that materially changes the
database architecture is a human gate).

## Context
Phase 3 must answer on the dashboard: which groups am I active in, what
happened recently, what was added or changed, what needs my attention.
Phase 4 adds settlements (their history must be auditable) and Phase 7
adds Smart Expense (candidate → approved expense must be auditable).

Facts from the Phase 1 schema:
- Expenses and solo groups are **hard-deleted** (M13, M15); nothing records
  that a deletion happened, by whom, or what was deleted.
- Edits overwrite the expense; only `updated_at` / `updated_by` remain —
  not what changed.
- Membership history is soft (`left_at`, `left_reason`, `removed_by`), but
  RLS shows members only **active** membership rows; ownership transfers
  leave no history.
- Account deletion tombstones profiles ("Deleted user"); ledger rows stay.

## Problem
Choose where activity comes from so the feed is truthful, private to the
group, and able to support settlements and Smart Expense audit trails,
without unnecessary complexity.

## Options
**A. Derived in the client** from RLS-visible rows (expenses by
`created_at`/`updated_at`/`updated_by`, active memberships by
`joined_at`). No database change. Cannot show deletions, leaves/removals,
ownership transfers or what an edit changed.

**B. Derived by a read-only SECURITY DEFINER RPC**
(`get_group_activity(group, before, limit)`, authorization-first like
`get_ledger_identities`). Adds leaves/removals (from soft history); still
no deletions, transfers or edit details. One new function (production
migration later), no new table.

**C. Append-only activity log** (`group_events`: id, group_id, actor_id,
kind, subject_id, payload jsonb with before/after cents, created_at),
written **inside** the existing SECURITY DEFINER RPCs in the same
transaction (so an event exists iff the change committed); no client
INSERT/UPDATE/DELETE; RLS: readable by active members of the group;
immutable (guard trigger); payload holds ids and amounts only (names
resolved at read time via ledger identities, so account-deletion
tombstones apply). Backfill: synthesize "created" events from existing
rows once (clearly marked as backfilled). Shows everything, including
deletions and transfers, and becomes the audit substrate for Phase 4
settlements and Phase 7 Smart Expense.

## Decision
**C — an append-only `group_events` log — subject to operator approval**
(Software Architect review 2026-09-27: recommends C; confirms it is a
material database architecture change requiring explicit operator approval
before any implementation, including local or SplitChat-Dev runs). Until
approved, Phase 3 builds only on existing data (see "Interim scope").

### Conditions (Software Architect)
1. **Not a source of truth.** Balances, settlements and Smart Expense
   candidates are never derived from events; events are feed and audit
   only. Settlements (Phase 4) and candidates (Phase 7) keep their own
   tables of record; events point to them.
2. **Table** `public.group_events`: `id bigint identity`, `group_id` →
   groups ON DELETE CASCADE, `actor_id` → profiles ON DELETE SET NULL (null
   = system / account deletion), `kind text` with a CHECK list,
   `subject_id uuid` (no FK — subjects can be hard-deleted),
   `subject_user_id uuid`, `payload jsonb` with `"v": 1`, `backfilled
   boolean`, `created_at`.
3. **Kinds (Phase 3):** `group_created`, `member_added`,
   `member_rejoined`, `member_left`, `member_removed`,
   `member_account_deleted`, `ownership_transferred`, `expense_created`,
   `expense_updated`, `expense_deleted`. Later phases add their own kinds
   by their own migrations and ADRs.
4. **Payload privacy:** ids, integer cents, dates, payer/participant ids
   only; updates store before/after of changed fields and a
   `description_changed` flag (never the text); never names, emails,
   avatars or notes — names are resolved at read time, so tombstones apply.
   **Open operator decision:** whether `expense_deleted` keeps a truncated
   description snapshot (default: no).
5. **Identity resolution:** extend `get_ledger_identities` (or add a
   companion) so ex-member ids referenced by events resolve to names.
6. **Readers:** RLS SELECT for active members of the group only (as every
   other table); former members see nothing; no client write privileges.
7. **Immutability:** guard trigger rejects UPDATE, and DELETE unless it is
   the `delete_group` cascade (tested both ways).
8. **Writers:** one private helper `record_group_event(...)` called inside
   the existing SECURITY DEFINER functions in the same transaction
   (functions know the intent and the "before" values); also
   `handle_new_group`, `add_group_member_by_email`,
   `handle_auth_user_deleting`, `admin_release_ownership`;
   `delete_expense` captures the expense and splits before deleting. A
   harness test asserts exactly one event per mutating path and none on
   rollback.
9. **`delete_group`** (solo groups only) records nothing; the group's
   events cascade away with it.
10. **Backfill:** one-off, insert-only, idempotent, in the release batch:
    `expense_created`, `member_added`, `member_left/removed/account_deleted`
    from existing columns, all `backfilled = true`; the UI states that
    history before go-live may be incomplete (pre-go-live deletions, edits
    and transfers cannot be recovered).
11. **Pagination:** keyset on `(created_at desc, id desc)`; index
    `(group_id, created_at desc, id desc)`; bounded page size.
12. **Retention:** lives as long as the group (like the ledger); no TTL.
13. **Rollout:** operator approval → migration in the repo → local
    harness tests (7–10) → SplitChat-Dev rehearsal → a reviewed production
    release batch with its own gate.

### Interim scope (no approval needed, no database change)
Dashboard from data visible today: my groups (member counts, role, last
activity), **"Recent expenses"** (not "Activity") across my groups from
`created_at` / `updated_at` / `updated_by`, and honest empty/loading
states. The feed sits behind an `ActivitySource` interface (keyset
`before`/`limit`) with a client-side adapter, so the event-log adapter can
replace it without UI changes. No balances or owed amounts until Phase 4
owns the balance calculation.

## Consequences / risks (C)
Every write RPC gains an insert (small cost); a new table in production
(a later reviewed release batch with pre/post checks); retention and
personal-data handling follow the ledger (ids only, names resolved at read
time). A/B would need replacing later anyway to support Phases 4 and 7.
