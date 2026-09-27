# ADR-0002: Ledger write path and where financial invariants are enforced

**Status:** Accepted 2026-09-26 (Phase 1 design approval) · **Date:** 2026-09-26 · **Detail:** design §A3, M1/M3/M4

## Context
`expenses` and `expense_splits` are writable directly by `authenticated`
through PostgREST (`public_schema.sql` L934-977, L1194-1205). Only the
`create_equal_split_expense` RPC computes splits. QS-1 (cross-group move) and
QS-3 (split sums bypassable) follow from this.

## Problem
Guarantee ledger integrity (immutable group, balanced splits, member-only
participants) regardless of client behaviour.

## Options considered
1. RLS only.
2. RPC-only writes, no database backstop.
3. RPC-only writes **plus** database triggers/constraints.
4. A materialised total column with a CHECK.

## Decision
3. Clients write the ledger only through SECURITY DEFINER RPCs. Triggers
backstop every role:
- immutable `expenses.id, group_id, created_by, created_at` and split
  `expense_id, user_id`;
- a deferred constraint trigger enforcing ≥1 split and
  `sum(share_amount) = amount` at commit;
- payer and participants must have a membership row in the group;
- `split_type` narrowed to `'equal'`.

## Rationale
RLS cannot express cross-row sums and is already bypassed; RPC-only leaves
service_role, dashboard SQL and future RPC bugs unguarded; a total column
duplicates state.

## Consequences
Direct write policies are dropped; any future ledger change uses RPCs
(edit/delete RPCs in M13). Existing data that violates the invariants blocks
M4 until a separately approved fix.

## Risks
Deferred triggers add commit-time cost (small tables; acceptable). Existing
unbalanced data is detected by pre-checks Q4/Q5.
