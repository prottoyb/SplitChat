-- M1 regression (QS-1): expense and split identity columns are immutable
-- for every role; ordinary edits still work.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');  -- Alice: X1 creator, G1 owner, G2 member
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises(
  $$UPDATE public.expenses SET group_id = '10000000-0000-4000-8000-000000000002'
     WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  'P0001', 'creator cannot move an expense to another group', 'immutable_field');
SELECT tests.assert_raises(
  $$UPDATE public.expenses SET created_by = '00000000-0000-4000-8000-00000000000b'
     WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  'P0001', 'creator cannot reassign created_by', 'immutable_field');
SELECT tests.assert_raises(
  $$UPDATE public.expense_splits SET user_id = '00000000-0000-4000-8000-00000000000e'
     WHERE expense_id = '20000000-0000-4000-8000-000000000001'
       AND user_id = '00000000-0000-4000-8000-00000000000b'$$,
  'P0001', 'split cannot be reassigned to another user', 'immutable_field');
SELECT tests.assert_raises(
  $$UPDATE public.expense_splits SET expense_id = '20000000-0000-4000-8000-000000000002'
     WHERE expense_id = '20000000-0000-4000-8000-000000000001'
       AND user_id = '00000000-0000-4000-8000-00000000000b'$$,
  'P0001', 'split cannot be moved to another expense', 'immutable_field');
ROLLBACK;

-- The guard applies to privileged roles too (service_role, postgres, dashboard SQL).
BEGIN;
SET LOCAL ROLE service_role;
SELECT tests.assert_raises(
  $$UPDATE public.expenses SET group_id = '10000000-0000-4000-8000-000000000002'
     WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  'P0001', 'service_role cannot move an expense', 'immutable_field');
RESET ROLE;
SET LOCAL ROLE postgres;
SELECT tests.assert_raises(
  $$UPDATE public.expenses SET group_id = '10000000-0000-4000-8000-000000000002'
     WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  'P0001', 'postgres cannot move an expense', 'immutable_field');
ROLLBACK;

-- Unrelated columns remain editable, and G2 still cannot see G1 data.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok(
  $$UPDATE public.expenses SET description = 'Weekly groceries'
     WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  'description is still editable by the creator');
RESET ROLE;
SELECT tests.login('00000000-0000-4000-8000-00000000000c');
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq(
  (SELECT count(*) FROM public.expense_splits WHERE expense_id = '20000000-0000-4000-8000-000000000001'),
  0::bigint, 'G2-only member cannot see G1 splits');
ROLLBACK;

SELECT tests.assert(
  NOT has_schema_privilege('authenticated', 'private', 'USAGE')
  AND NOT has_schema_privilege('anon', 'private', 'USAGE'),
  'private schema is not usable by client roles');
SELECT tests.assert(
  NOT has_function_privilege('authenticated', 'private.guard_expense_immutables()', 'EXECUTE'),
  'guard function is not executable by clients');
