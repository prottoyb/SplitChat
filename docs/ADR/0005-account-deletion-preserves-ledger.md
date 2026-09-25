# ADR-0005: Account deletion preserves the historical ledger

**Status:** Proposed · **Date:** 2026-09-26 · **Detail:** design §A5, M5/M11, CA-2

## Context
Deleting an owner's auth user cascades `groups` → `expenses` →
`expense_splits`, destroying other members' records (QS-4). Deleting a member
with history is blocked by RESTRICT FKs. Operator decision: the historical
ledger must survive account deletion; owners must transfer before deleting.

## Problem
Allow account deletion without losing or invalidating shared financial
history.

## Options considered
1. Keep the profiles cascade and RESTRICT everything — accounts with history
   could never be deleted.
2. Forbid hard-deleting `auth.users` — unenforceable; the dashboard deletes.
3. Profile tombstones decoupled from `auth.users`, with a BEFORE DELETE
   trigger enforcing the ownership rule.
4. A separate `profiles.auth_user_id` mapping.

## Decision
3.
- Interim (M5): `groups_created_by_fkey` → RESTRICT.
- Final (M11): drop `profiles_id_fkey`; domain FKs point to `profiles` with
  RESTRICT; `expenses.group_id` → RESTRICT; add `profiles.deleted_at`.
- A BEFORE DELETE trigger on `auth.users` blocks deletion by the active owner
  of a multi-member group (`owner_must_transfer`); otherwise it marks
  memberships `account_deleted`, demotes a sole owner, and tombstones the
  profile ("Deleted user", no avatar). Ledger rows are never modified.
- Operator override (DS-2): `private.admin_release_ownership(p_user_id)`,
  executable only by `postgres` (not `service_role` or any client role), transfers each of the user's owned
  multi-member groups to its longest-standing active member, so an owner
  cannot make their account undeletable. Each use needs its own execution
  approval.
- M11 is gated: it is not proposed for prod until the dev rehearsal proves
  the `auth.users` trigger (allowed and blocked paths), or the operator-run
  fallback (`private.prepare_account_deletion`) is fully designed and
  reviewed (DS-5).

## Rationale
Only option 3 satisfies both "history survives" and "accounts can be
deleted".

## Consequences
`profiles` outlive auth users; the UI shows "Deleted user". GoTrue
soft-delete bypasses the trigger, so hard delete is the supported path. M11
is not fully reversible once an account has been deleted.

## Risks
Supabase may no longer allow new triggers on `auth.users` (CA-2): this must be
proven on the dev project first. Fallback: keep RESTRICT plus an explicit
deletion-request RPC. Personal-data minimisation: the tombstone clears name
and avatar; email lives only in `auth.users`.
