# Phase 4 — Balances, debt simplification and settlements

**Status:** ✅ complete 2026-09-28 (QA/Security PASS, Senior APPROVE). Branch `feature/phase4-balances-settlements` (from
the Phase 3 head). Architecture: ADR-0010 (accepted after Software
Architect review, FIT WITH CONDITIONS, conditions 1–10 incorporated; no
operator approval required).

## Scope

1. **M17 settlements** (`supabase/migrations/20260928110000_settlements.sql`):
   `public.settlements` with database backstops, RLS read for active
   members, no client writes, void-only immutability;
   `get_group_balances`, `record_settlement`, `void_settlement`;
   `delete_group` refuses a group with settlements; `settlement_recorded` /
   `settlement_voided` events; ledger identities include settlement parties.
2. **Harness case 220** (and a dblink concurrency case): boundaries,
   partial chaining, over-settlement and reversal refusal, permissions,
   former and deleted members, net sums to zero, idempotency, immutability,
   concurrency, events.
3. **Frontend `features/balances` and `features/settlements`:** group
   balances, who owes whom, the deterministic plan (`simplifyDebts`, shared
   vectors), record (full or partial) and void settlements, history;
   integer cents throughout; the server re-checks every amount.
4. SplitChat-Dev rehearsal (M17 only) and API checks.

## Outcome

| Item | Result |
|---|---|
| Migration | `20260928110000_settlements.sql` (M17): `settlements` (void-only trigger, composite membership FKs, amount/date/note/void CHECKs, idempotency key unique per group and creator), `private.group_balances`, `get_group_balances`, `record_settlement` (unlocked auth check → group `FOR UPDATE` → re-check; `nothing_to_settle` / `exceeds_balance`), `void_settlement` (party or owner, once), event kinds, `delete_group` backstop. Rollback restores `delete_group` and the kind CHECK exactly (up/down/up verified); fix-forward once settlements exist |
| Names | settlement parties are named through the events' `people` (no change to `get_ledger_identities`) |
| Harness | case 220 (75 assertions: surface, balances, partial chaining, refusal of over-settlement and reversal, validation, permissions, former and deleted members, idempotency, voiding, RLS, backstops, solo delete), case 221 (dblink: double payment, racing retry, expense creation and edit wait); test:db 26/26 (564) |
| Frontend | `features/balances` (server balances with integrity checks, `simplifyDebts` + shared vectors + generated-ledger properties, `BalanceList`, `RepaymentPlan`), `features/settlements` (API, form validation, `SettlementForm`, `SettlementHistory` with void, `/groups/:id/balances`); group page links to it; activity feed describes settlement events and skips unknown kinds |
| Tests | Vitest 383 (29 files); lint, tsc, build clean |

## SplitChat-Dev rehearsal (2026-09-28)

- Dev at 18 versions (batch 3 + M16); pinned CLI `db push` from a staging
  copy applied only `20260928110000`.
- Read-only ledger fingerprint (groups, memberships, expenses, splits,
  events: counts, cent sums, hashes) identical before and after.
- Dev schema == harness schema after M17: **IDENTICAL (2453 normalised
  lines)**.
- `scripts/rehearsal/api-settlements.mjs`: **19/19** — server balances as
  JSON integers, outsider refused, partial payment, over-settlement /
  reversal / non-party refused, idempotent retry, no direct insert/update,
  outsider and anon read nothing, void permissions, void once, history
  kept, former member settled by the owner, events in order without note
  or reason text. `api-activity.mjs` still **11/11**.

## Reviews

- **Software Architect** (ADR-0010): FIT WITH CONDITIONS; conditions 1–10
  incorporated (condition 4 refined: `delete_group` refuses rather than
  deletes settlements).
- **QA/Security:** PASS, no CRITICAL/HIGH. Recommended an expense
  edit-vs-settlement concurrency test: added to case 221 (13 assertions) —
  the edit's event write serialises on the group row, and the waiting
  settlement checks the edited balances. Deferred LOW: `settled_on`'s upper
  bound (a year ahead) is enforced by the RPC only, not a table CHECK (same
  as `expense_date`; direct writes are revoked) — Phase 8.
- **Senior Review:** APPROVE, no CRITICAL/HIGH/MEDIUM. LOW fixed: the
  `nothing_to_settle` message no longer implies a stale balance only.

## Production

Not applied. M17 joins M16 in the next production release batch (M16 must precede M17: M17 extends the event kind CHECK).
