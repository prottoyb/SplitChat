-- M4 regression: financial invariants hold for privileged roles too
-- (design tests F2-F7). Deferred checks are forced with
-- SET CONSTRAINTS ALL IMMEDIATE inside the asserted block.

-- F2: an unbalanced split change is rejected at commit.
BEGIN;
SET LOCAL ROLE postgres;
SELECT tests.assert_raises($t$DO $b$ BEGIN
    UPDATE public.expense_splits SET share_amount = 49.00
     WHERE expense_id = '20000000-0000-4000-8000-000000000001'
       AND user_id = '00000000-0000-4000-8000-00000000000b';
    SET CONSTRAINTS ALL IMMEDIATE;
  END $b$ $t$, 'P0001', 'F2: splits that no longer sum to the amount are rejected', 'expense_unbalanced');

-- A balanced multi-statement rewrite is fine.
SELECT tests.assert_ok($t$DO $b$ BEGIN
    UPDATE public.expense_splits SET share_amount = 60.00
     WHERE expense_id = '20000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000a';
    UPDATE public.expense_splits SET share_amount = 40.00
     WHERE expense_id = '20000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000b';
    SET CONSTRAINTS ALL IMMEDIATE;
  END $b$ $t$, 'balanced rewrite across two statements is accepted');
ROLLBACK;

-- F3: an expense with no splits is rejected.
BEGIN;
SET LOCAL ROLE service_role;
SELECT tests.assert_raises($t$DO $b$ BEGIN
    INSERT INTO public.expenses (group_id, description, amount, paid_by, created_by)
    VALUES ('10000000-0000-4000-8000-000000000001', 'Orphan', 5.00,
            '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a');
    SET CONSTRAINTS ALL IMMEDIATE;
  END $b$ $t$, 'P0001', 'F3: expense without splits is rejected', 'expense_unbalanced');
ROLLBACK;

-- F4: changing the amount without the splits is rejected.
BEGIN;
SET LOCAL ROLE postgres;
SELECT tests.assert_raises($t$DO $b$ BEGIN
    UPDATE public.expenses SET amount = 101.00 WHERE id = '20000000-0000-4000-8000-000000000001';
    SET CONSTRAINTS ALL IMMEDIATE;
  END $b$ $t$, 'P0001', 'F4: amount change without matching splits is rejected', 'expense_unbalanced');
ROLLBACK;

-- F5: deleting an expense cascades its splits without tripping the check.
BEGIN;
SET LOCAL ROLE postgres;
SELECT tests.assert_ok($t$DO $b$ BEGIN
    DELETE FROM public.expenses WHERE id = '20000000-0000-4000-8000-000000000001';
    SET CONSTRAINTS ALL IMMEDIATE;
  END $b$ $t$, 'F5: deleting an expense (cascading its splits) is accepted');
ROLLBACK;

-- F6: payer and participants must be members of the expense's group.
BEGIN;
SET LOCAL ROLE postgres;
SELECT tests.assert_raises(
  $$INSERT INTO public.expense_splits (expense_id, user_id, share_amount)
    VALUES ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000c', 0.00)$$,
  'P0001', 'F6: non-member cannot be added as a split participant', 'ledger_member_required');
SELECT tests.assert_raises(
  $$UPDATE public.expenses SET paid_by = '00000000-0000-4000-8000-00000000000c'
     WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  'P0001', 'F6: non-member cannot become the payer', 'ledger_member_required');
SELECT tests.assert_ok(
  $$UPDATE public.expenses SET paid_by = '00000000-0000-4000-8000-00000000000b'
     WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  'payer can change to another group member');
SELECT tests.assert_ok(
  $$UPDATE public.expenses SET description = 'Groceries (edited)'
     WHERE id = '20000000-0000-4000-8000-000000000002'$$,
  'editing other columns does not re-check the payer');
ROLLBACK;

-- F7: only equal splits exist.
BEGIN;
SET LOCAL ROLE postgres;
SELECT tests.assert_raises(
  $$UPDATE public.expenses SET split_type = 'exact' WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  '23514', 'F7: split_type other than equal is rejected');
ROLLBACK;

-- The RPC path still produces balanced expenses under the invariants.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok($t$DO $b$ BEGIN
    PERFORM public.create_equal_split_expense_v2('10000000-0000-4000-8000-000000000001', 'Rent', 100001, current_date,
      '00000000-0000-4000-8000-00000000000a',
      ARRAY['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b',
            '00000000-0000-4000-8000-00000000000e']::uuid[]);
    SET CONSTRAINTS ALL IMMEDIATE;
  END $b$ $t$, 'RPC-created expense satisfies the invariants at commit');
ROLLBACK;
