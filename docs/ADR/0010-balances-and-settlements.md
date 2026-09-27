# ADR-0010: Balances, debt simplification and settlements

**Status:** Accepted 2026-09-28 (Phase 4). Software-architect review: FIT
WITH CONDITIONS; all ten conditions are incorporated below. Operator
approval not required: it extends the ADR-0002 RPC-plus-backstop model and
the ADR-0009 event log without a new service, dependency or auth-model
change.

## Context
Phase 4 must show per-group balances, who owes whom, a deterministic
simplified repayment plan, and let people record (partial) settlements,
with history, without over-settling or accidentally reversing a debt.
Money is integer cents (ADR-0006); ledger writes go only through reviewed
SECURITY DEFINER RPCs with database backstops (ADR-0002); client money
math is presentation only and numbers that settlements act on come from or
are checked by the server (ADR-0008 rule 9); every change is recorded in
the activity log (ADR-0009, which reserves settlement kinds to this phase).

## Options considered
- **Derive balances client-side from expenses** — rejected: the server
  must enforce over-settlement, so it needs the same numbers anyway.
- **Materialised balance table** — rejected: a second source of truth
  that can drift; group ledgers are small, one aggregate query is cheap.
- **Simplifier in SQL and TypeScript** — rejected (architect condition 6):
  two implementations to keep in lockstep for a plan that is advisory.
  The server enforces the limits that matter on every settlement, so the
  plan is computed once, in TypeScript, from server balances.

## Decision

### Balances (net model)
For each person with a ledger reference in a group:
`net = Σ paid (expenses.amount_cents where paid_by = p)
     − Σ owed (expense_splits.share_cents where user_id = p)
     + Σ settlements paid by p − Σ settlements received by p`
(non-voided settlements only). Positive = is owed; negative = owes.
Σ net over a group is always 0 (splits balance; each settlement moves the
same cents out and in) — a tested invariant. Former and deleted-account
members keep their balance (history is never rewritten; they can still be
settled with; names come from `get_ledger_identities`).

`public.get_group_balances(p_group_id)` — SECURITY DEFINER, STABLE,
authorization first (`not_found_or_forbidden` unless an active member),
returns `(user_id, paid_cents, owed_cents, settled_out_cents,
settled_in_cents, net_cents)` as `bigint`, one aggregate query. A row
appears when **any** component is non-zero. PostgREST serialises `bigint`
as a JSON number; all values are bounded far below 2^53 by the amount
CHECKs, and the client reads them with `readCents` (safe-integer check).

### Simplified repayments (deterministic, client-side)
`simplifyDebts(balances)` in `features/balances/domain`: debtors (net < 0)
and creditors (net > 0), each sorted by magnitude descending, ties by
user id ascending (plain `<` on lowercase UUID strings); repeatedly
transfer `min(debt, credit)` from the first debtor to the first creditor,
advancing whichever reaches zero. At most n − 1 transfers; identical
inputs give identical plans. Tested with shared vectors
(`src/features/balances/domain/fixtures/settle-up-vectors.json`). The plan
is advisory; each suggested payment is submitted through
`record_settlement`, which re-checks it against live balances.

### Settlements (table of record)
`public.settlements`:

| column | rule |
|---|---|
| `id uuid` PK | |
| `group_id uuid NOT NULL` | FK groups, RESTRICT |
| `from_user`, `to_user uuid NOT NULL` | composite FKs `(group_id, from_user)` / `(group_id, to_user)` → `group_members(group_id, user_id)` NO ACTION; `from_user <> to_user` |
| `amount_cents bigint NOT NULL` | `> 0 AND ≤ 999999999999` |
| `settled_on date NOT NULL` | same bounds as `expense_date` |
| `note text` | NULL or 1–200 chars after trim; untrusted, rendered escaped |
| `created_by uuid NOT NULL`, `created_at` | |
| `client_request_id uuid` | optional; UNIQUE `(group_id, created_by, client_request_id)` |
| `voided_at`, `voided_by`, `void_reason` | all NULL or all set; reason 1–200 chars |

Indexes on `group_id`, `from_user`, `to_user`. RLS: active members read;
INSERT/UPDATE/DELETE revoked from `anon`/`authenticated`. An immutability
trigger allows only one UPDATE that sets the void columns from NULL, and
refuses every DELETE. Settlements are **voided, never deleted**; no
un-void.

- `record_settlement(p_group_id, p_from_user, p_to_user, p_amount_cents,
  p_settled_on, p_note, p_client_request_id)`: unlocked authorization
  check (active member, else `not_found_or_forbidden`), input validation,
  then `SELECT … FROM groups WHERE id = p_group_id FOR UPDATE`, then
  authorization **re-checked under the lock**. The caller must be one of
  the two parties or the group owner (`forbidden`). With the lock held it
  recomputes balances and requires `net(from) < 0`, `net(to) > 0` and
  `amount ≤ min(−net(from), net(to))` — a settlement can never reverse a
  debt's direction or over-settle; partial settlements are allowed and
  chain until the debt is zero. A repeated `client_request_id` returns the
  existing settlement's id without a second write.
  Errors: `invalid_parties`, `invalid_amount`, `nothing_to_settle`,
  `exceeds_balance`, `invalid_date`, `invalid_note`, `forbidden`,
  `not_found_or_forbidden`.
- `void_settlement(p_settlement_id, p_reason)`: locks the group row and
  then the settlement row; allowed for either party or the active owner
  (active members only); voiding is always allowed (it can only restore a
  debt that existed); `already_voided`.
- Expense RPCs that change balances (`create/update/delete`) already lock
  the expense or group; settlement serialises on the group row lock.
- Events (ADR-0009): `group_events_kind_check` extended with
  `settlement_recorded` and `settlement_voided`, written in the same
  transaction; payload `{v, amount_cents, settled_on}`, people = both
  parties; never the note or reason.
- `delete_group` refuses a group with any settlement
  (`group_has_shared_history`). A settlement needs two distinct members, so
  a group that passes the "only ever one member" rule never has one; the
  explicit check is a backstop (refinement of architect condition 4:
  nothing to delete, so settlements are never deleted by any path).

## Consequences
One new table and three functions plus changes to `delete_group` and the
event kind CHECK (production migration in the next release batch).
Balances depend on expenses; editing or deleting an expense after a
settlement can leave someone over-settled — shown as a reversed net
balance, never silently corrected.

## Risks
An expense edit committed after a settlement can still change balances
(visible, not corrupting). The client plan could briefly differ from live
balances; the server check makes that harmless (`exceeds_balance`,
`nothing_to_settle`).

## Required tests
Amount/date/note boundaries; partial settlements chaining to zero; refusal
of over-settlement and reversal; party/owner/outsider/former-member
permissions for record and void; settling with a former and a deleted
member; group net always 0; concurrent settlements (dblink) cannot jointly
over-settle; idempotent retry; immutability; `delete_group`; exactly one
event per successful call and none for refused ones.
