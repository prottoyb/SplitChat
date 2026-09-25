-- QS-3: direct table writes bypass the RPC's financial invariants.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok(
  $$INSERT INTO public.expenses (group_id, description, amount, paid_by)
    VALUES ('10000000-0000-4000-8000-000000000001', 'No splits', 99.00, '00000000-0000-4000-8000-00000000000a')$$,
  'KNOWN-BAD[M3]: member inserts an expense with no splits directly');
SELECT tests.assert_ok(
  $$UPDATE public.expense_splits SET share_amount = 1.00
     WHERE expense_id = '20000000-0000-4000-8000-000000000001'
       AND user_id = '00000000-0000-4000-8000-00000000000b'$$,
  'KNOWN-BAD[M3]: creator rewrites a split so it no longer sums to the amount');
SELECT tests.assert_eq(
  (SELECT sum(share_amount) FROM public.expense_splits WHERE expense_id = '20000000-0000-4000-8000-000000000001'),
  51.00::numeric, 'KNOWN-BAD[M4]: X1 splits now sum to 51.00 against an amount of 100.00');
ROLLBACK;
