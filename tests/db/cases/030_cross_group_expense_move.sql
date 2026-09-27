-- QS-1: an expense creator who belongs to two groups used to be able to move
-- an expense (and its splits) into the other group. FIXED[M1].
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');  -- Alice: G1 owner, G2 member
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises(
  $$UPDATE public.expenses SET group_id = '10000000-0000-4000-8000-000000000002'
     WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  '42501', 'FIXED[M1,M3]: creator can no longer move expense X1 from G1 to G2');
RESET ROLE;

SELECT tests.login('00000000-0000-4000-8000-00000000000c');  -- Cara: G2 only
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq(
  (SELECT count(*) FROM public.expense_splits WHERE expense_id = '20000000-0000-4000-8000-000000000001'),
  0::bigint, 'FIXED[M1]: G2 member still cannot read G1 splits');
ROLLBACK;
