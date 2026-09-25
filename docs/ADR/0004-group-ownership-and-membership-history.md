# ADR-0004: Group ownership source of truth and membership history

**Status:** Proposed · **Date:** 2026-09-26 · **Detail:** design §A2, §A4, §A5, M7/M9/M10

## Context
Ownership is recorded twice (`groups.created_by`, `group_members.role`) with
nothing linking them and no transfer. Leaving or removal hard-deletes the
membership row. Operator decisions: ownership is transferable to an active
member; an owner cannot leave while owning an active multi-member group;
add-by-email is kept but hardened.

## Problem
One authoritative, transferable ownership model, with membership history that
keeps the ledger valid.

## Options considered
- Ownership truth: `created_by` vs `role`.
- History: hard delete (today), soft-leave columns, status enum, separate
  history table / multi-stint rows.

## Decision
- `group_members.role` is authoritative, with a partial unique index (one
  active owner per group). `groups.created_by` stays as an immutable creator
  audit field.
- Soft leave: `left_at`, `left_reason`, `removed_by`; an owner row can never
  be "left". Re-adding a former member reactivates the row.
- All membership changes go through RPCs (`add_group_member_by_email`,
  `remove_group_member`, `leave_group`, `transfer_group_ownership`); direct
  `group_members` writes are revoked.
- Former members lose all access (no broadening). No admin role in Phase 1
  (open question G2).

## Rationale
Role-based ownership supports transfer without rewriting group rows; soft
leave keeps history with minimal schema change; a history table adds moving
parts with no current requirement.

## Consequences
Frontend owner checks move from `created_by` to the caller's membership role.
Showing former members' names needs an explicit visibility decision (G1).

## Risks
Existing data with ≠1 owner row, or owner ≠ creator, blocks M7 (pre-checks
Q9/Q10). Add-by-email remains a rate-limited, owner-only existence probe —
accepted by the operator's decision to keep add-by-email.
