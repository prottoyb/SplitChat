# ADR-0006: Integer cents at the API boundary and canonical equal-split allocation

**Status:** Proposed · **Date:** 2026-09-26 · **Detail:** design §A7, §A8, M12

## Context
Storage is `numeric(12,2)` (exact). The client sends `cents/100` as a JSON
number and sums floats for display. The split algorithm exists in TypeScript
and PL/pgSQL with different participant ordering, so the previewed remainder
cent can go to a different person than recorded (QS-7). Operator decision:
AUD only, integer cents at the boundary.

## Problem
Exact money across the boundary, and one deterministic allocation rule shared
by client and database.

## Options considered
- Money: convert columns to bigint (destructive); views exposing cents;
  generated `*_cents` columns.
- Ordering: input order (today); `joined_at`; payer first; ascending UUID.

## Decision
- Keep `numeric(12,2)`; add generated `amount_cents` / `share_cents` bigint
  columns. RPCs take `p_amount_cents bigint`; the client never does float
  arithmetic on money.
- Equal split: dedupe, sort ascending by UUID, base = floor(total / n), the
  first `total % n` participants get +1 cent.
- One DB function (`private.equal_split_cents`) and one TS function
  (`allocateEqualSplit`), both tested against shared JSON vectors.
- RPC errors are stable codes, mapped to text in the client.

## Rationale
No destructive type change. UUID order is identical in Postgres (bytewise)
and JS (lowercase string compare), and independent of UI state or rejoin
history.

## Consequences
New RPC `create_equal_split_expense_v2`; the legacy RPC is wrapped, then
dropped after the frontend deploys. Remainder recipients for **new** expenses
change from "first selected" to "lowest UUID"; existing rows are unchanged.

## Risks
Generated columns rewrite the tables under a brief lock (small tables).
Currency is implicitly AUD; multi-currency would need a new ADR.
