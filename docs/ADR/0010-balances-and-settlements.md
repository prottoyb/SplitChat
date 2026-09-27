# ADR-0010: Balances, debt simplification and settlements

**Status:** Proposed 2026-09-28 (Phase 4). Architecture review pending.

## Context
Phase 4 must show per-group balances, who owes whom, a deterministic
simplified repayment plan, and let people record (partial) settlements,
with history, without over-settling or accidentally reversing a debt.
Money is integer cents (ADR-0006); ledger writes go only through reviewed
SECURITY DEFINER RPCs with database backstops (ADR-0002); client money
math is presentation only and numbers that settlements act on come from or
are checked by the server (ADR-0008 rule 9); every change is recorded in
the activity log (ADR-0009, which reserves settlement kinds to this phase).

## Decision

### Balances (net model)
For each person with a ledger reference in a group:
`net = Σ paid (expenses.amount_cents where paid_by = p)
     − Σ owed (expense_splits.share_cents where user_id = p)
     + Σ settlements paid by p − Σ settlements received by p`
(non-voided settlements only). Positive = is owed; negative = owes.
Σ net over a group is always 0 (splits balance; each settlement moves the
same cents out and in). Former members keep their balance (history is
never rewritten; they can still be settled with).

`public.get_group_balances(p_group_id)` — SECURITY DEFINER, authorization
first (`not_found_or_forbidden` unless an active member), returns
`(user_id, paid_cents, owed_cents, settled_out_cents, settled_in_cents,
net_cents)`, computed in one query from the ledger. Only people with a
non-zero row appear.

### Simplified repayments (deterministic)
Greedy on net balances: debtors (net < 0) and creditors (net > 0), each
sorted by amount descending, then user id ascending; repeatedly transfer
`min(debt, credit)` from the first debtor to the first creditor, advancing
the one that reaches zero. Produces at most n − 1 transfers, deterministic
for equal inputs. Implemented once in SQL (`private.simplify_debts`,
used by `public.get_group_settle_up(p_group_id)`) and once in TypeScript
(`simplifyDebts`), tested against shared vectors
(`src/features/balances/domain/fixtures/settle-up-vectors.json`).

### Settlements (table of record)
`public.settlements(id uuid, group_id → groups RESTRICT, from_user →
profiles, to_user → profiles, amount_cents bigint > 0, settled_on date,
note text ≤ 200, created_by → profiles, created_at, voided_at, voided_by,
void_reason)`, `from_user <> to_user`, both must have a membership row in
the group (as for splits). RLS: active members read; no client writes.
Settlements are **voided, never deleted** (history).

- `record_settlement(p_group_id, p_from_user, p_to_user, p_amount_cents,
  p_settled_on, p_note)`: authorization first (active member); the caller
  must be one of the two parties or the group owner; under a group-level
  lock, re-reads balances and requires `net(from) < 0`, `net(to) > 0` and
  `amount ≤ min(−net(from), net(to))` — so a settlement can never reverse a
  debt's direction or over-settle; partial settlements are allowed.
  Errors: `invalid_parties`, `invalid_amount`, `nothing_to_settle`,
  `exceeds_balance`, `invalid_date`, `invalid_note`, `forbidden`.
- `void_settlement(p_settlement_id, p_reason)`: creator or owner; sets the
  void columns once (`already_voided`).
- Events: `settlement_recorded`, `settlement_voided` (ids and cents only).
- `delete_group`'s shared-history check also counts settlements naming
  another user (a solo group has none).

## Consequences
One new table and five functions (production migration in the next
release batch). Balances depend on expenses; editing or deleting an
expense after a settlement can leave someone over-settled — shown as a
reversed net balance, never silently corrected.

## Risks
Concurrency between settlement and expense edits is serialised by the
group lock on settlement; an expense edit racing a settlement can still
change balances afterwards (visible, not corrupting).
