-- QS-1: an expense creator who belongs to two groups can move an expense
-- (and its splits) into the other group.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');  -- Alice: G1 owner, G2 member
SET LOCAL ROLE authenticated;
WITH moved AS (
  UPDATE public.expenses SET group_id = '10000000-0000-4000-8000-000000000002'
   WHERE id = '20000000-0000-4000-8000-000000000001' RETURNING 1)
SELECT tests.assert_eq((SELECT count(*) FROM moved), 1::bigint,
  'KNOWN-BAD[M1]: creator moves expense X1 from G1 to G2');
RESET ROLE;

SELECT tests.login('00000000-0000-4000-8000-00000000000c');  -- Cara: G2 only
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq(
  (SELECT count(*) FROM public.expense_splits WHERE expense_id = '20000000-0000-4000-8000-000000000001'),
  2::bigint, 'KNOWN-BAD[M1]: G2 member now reads splits of G1-only participants');
ROLLBACK;
