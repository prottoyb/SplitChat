# Phase 4 — Balances, debt simplification and settlements

**Status:** in progress. Branch `feature/phase4-balances-settlements` (from
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

## Production

Not applied. M17 joins M16 in the next production release batch.
