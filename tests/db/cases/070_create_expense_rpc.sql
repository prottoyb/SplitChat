-- create_equal_split_expense as it behaves in production.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000b');
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE new_expense AS
SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'Pizza', 10.00, current_date,
  '00000000-0000-4000-8000-00000000000b',
  ARRAY['00000000-0000-4000-8000-00000000000e', '00000000-0000-4000-8000-00000000000a',
        '00000000-0000-4000-8000-00000000000b']::uuid[]) AS id;
SELECT tests.assert_eq(
  (SELECT sum(share_amount) FROM public.expense_splits WHERE expense_id = (SELECT id FROM new_expense)),
  10.00::numeric, 'splits sum to the amount');
SELECT tests.assert_eq(
  (SELECT share_amount FROM public.expense_splits
    WHERE expense_id = (SELECT id FROM new_expense) AND user_id = '00000000-0000-4000-8000-00000000000e'),
  3.34::numeric, 'KNOWN-BAD[M12]: remainder cent follows input order (Eve listed first), not canonical order');
SELECT tests.assert_raises(
  $$SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'x', 1.00, current_date,
    '00000000-0000-4000-8000-00000000000b', ARRAY['00000000-0000-4000-8000-00000000000c']::uuid[])$$,
  'P0001', 'non-member participant rejected', 'One or more selected participants are not members of this group.');
SELECT tests.assert_raises(
  $$SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'x', 1.005, current_date,
    '00000000-0000-4000-8000-00000000000b', ARRAY['00000000-0000-4000-8000-00000000000b']::uuid[])$$,
  'P0001', 'more than two decimals rejected', 'Expense amount can have at most 2 decimal places.');
RESET ROLE;

SELECT tests.login('00000000-0000-4000-8000-00000000000c');
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises(
  $$SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'x', 1.00, current_date,
    '00000000-0000-4000-8000-00000000000c', ARRAY['00000000-0000-4000-8000-00000000000c']::uuid[])$$,
  'P0001', 'non-member caller rejected', 'You do not have access to this group.');
ROLLBACK;
