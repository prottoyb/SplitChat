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
Pending Software Architect review. Engineering-lead leaning: **C**, since
deletions, transfers and settlement/Smart-Expense audit are core to "trust
the numbers" — but C is a material database architecture change and needs
operator approval before implementation.

## Consequences / risks (C)
Every write RPC gains an insert (small cost); a new table in production
(a later reviewed release batch with pre/post checks); retention and
personal-data handling follow the ledger (ids only, names resolved at read
time). A/B would need replacing later anyway to support Phases 4 and 7.
