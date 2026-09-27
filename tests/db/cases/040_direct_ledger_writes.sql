-- QS-3: direct table writes used to bypass the RPC's financial invariants.
-- FIXED[M3]: clients hold no write privilege on the ledger tables.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises(
  $$INSERT INTO public.expenses (group_id, description, amount, paid_by)
    VALUES ('10000000-0000-4000-8000-000000000001', 'No splits', 99.00, '00000000-0000-4000-8000-00000000000a')$$,
  '42501', 'FIXED[M3]: member cannot insert an expense directly');
SELECT tests.assert_raises(
  $$UPDATE public.expense_splits SET share_amount = 1.00
     WHERE expense_id = '20000000-0000-4000-8000-000000000001'
       AND user_id = '00000000-0000-4000-8000-00000000000b'$$,
  '42501', 'FIXED[M3]: creator cannot rewrite a split directly');
SELECT tests.assert_raises(
  $$DELETE FROM public.expense_splits WHERE expense_id = '20000000-0000-4000-8000-000000000001'$$,
  '42501', 'FIXED[M3]: creator cannot delete splits directly');
SELECT tests.assert_raises(
  $$DELETE FROM public.expenses WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  '42501', 'FIXED[M3]: creator cannot delete an expense directly');
SELECT tests.assert_eq(
  (SELECT sum(share_amount) FROM public.expense_splits WHERE expense_id = '20000000-0000-4000-8000-000000000001'),
  100.00::numeric, 'X1 still balances');
ROLLBACK;

SELECT tests.assert(
  NOT EXISTS (SELECT 1 FROM pg_policies
               WHERE schemaname = 'public' AND tablename IN ('expenses', 'expense_splits') AND cmd <> 'SELECT'),
  'FIXED[M3]: no write policies remain on the ledger tables');
SELECT tests.assert(
  NOT has_table_privilege('authenticated', 'public.expenses', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.expense_splits', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.expenses', 'TRUNCATE'),
  'FIXED[M3]: authenticated holds no write privilege on the ledger');
