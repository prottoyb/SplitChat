SET LOCAL lock_timeout = '5s';

-- M14: drop the legacy numeric expense RPC (design §B M14; ADR-0006).
-- Since M12 it has been a thin wrapper around create_equal_split_expense_v2,
-- and since the M12 frontend commit (a5ed4e8) no frontend path calls it:
-- expense writes go through src/lib/expenseApi.ts (v2, update, delete).
--
-- Client/server compatibility boundary: a frontend older than a5ed4e8 calls
-- this function and stops being able to add expenses once it is gone. In
-- production this migration is therefore its own step (batch 3b), gated on
-- the frontend attestation in scripts/ops/prod.mjs: every live frontend must
-- contain a5ed4e8, or no frontend may be live.

DROP FUNCTION public.create_equal_split_expense(uuid, text, numeric, date, uuid, uuid[], text);
