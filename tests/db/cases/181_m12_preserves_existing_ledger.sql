-- M12 applied to a populated ledger rewrites no stored value: the generated
-- cents columns are derived, existing splits keep their historical remainder
-- recipients, and nothing else changes (ADR-0006 "existing rows are
-- unchanged"). The seeded ledger is taken back to its pre-M12 schema with the
-- reviewed rollback, snapshotted, then M12 is re-applied as postgres.
BEGIN;
-- Historical allocation that the canonical rule would NOT produce (Eve got the
-- extra cent): it must survive M12 as recorded.
INSERT INTO public.expenses (id, group_id, description, amount, paid_by, created_by)
VALUES ('20000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-000000000001', 'Pre-M12 dinner', 0.10,
        '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a');
INSERT INTO public.expense_splits (expense_id, user_id, share_amount) VALUES
  ('20000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000a', 0.03),
  ('20000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000b', 0.03),
  ('20000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-00000000000e', 0.04);
-- Run the deferred balance check now (it passes), so the ALTER TABLEs below
-- see no pending trigger events.
SET CONSTRAINTS ALL IMMEDIATE;

SET LOCAL ROLE postgres;
\ir ../../../supabase/rollbacks/20260927110000_money_cents_and_canonical_split.down.sql
RESET ROLE;
SELECT tests.assert(to_regclass('public.expenses') IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.expenses'::regclass
                                      AND attname = 'amount_cents' AND NOT attisdropped),
  'ledger is at the pre-M12 schema');
CREATE TEMP TABLE before_m12 AS
SELECT (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM public.expenses e) AS expenses,
       (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.expense_splits s) AS splits;

SET LOCAL ROLE postgres;
\ir ../../../supabase/migrations/20260927110000_money_cents_and_canonical_split.sql
RESET ROLE;

SELECT tests.assert_eq(
  (SELECT jsonb_agg(to_jsonb(e) - 'amount_cents' ORDER BY e.id) FROM public.expenses e),
  (SELECT expenses FROM before_m12), 'M12 changes no stored expense value (every column, every row)');
SELECT tests.assert_eq(
  (SELECT jsonb_agg(to_jsonb(s) - 'share_cents' ORDER BY s.id) FROM public.expense_splits s),
  (SELECT splits FROM before_m12), 'M12 changes no stored split value (every column, every row)');
SELECT tests.assert_eq(
  (SELECT array_agg(share_cents ORDER BY user_id) FROM public.expense_splits
    WHERE expense_id = '20000000-0000-4000-8000-0000000000a1'),
  ARRAY[3, 3, 4]::bigint[], 'a historical non-canonical allocation is kept as recorded, not re-allocated');
SELECT tests.assert(NOT EXISTS (
  SELECT 1 FROM public.expenses e
   WHERE e.amount_cents::numeric <> e.amount * 100
      OR e.amount_cents <> (SELECT sum(s.share_cents) FROM public.expense_splits s WHERE s.expense_id = e.id)),
  'derived cents are exact for every pre-existing expense');
ROLLBACK;
