-- M1 regression (QS-1): expense and split identity columns are immutable
-- for every role, including those that bypass privileges and RLS. (Clients
-- lose direct UPDATE entirely in M3; see 040.)
BEGIN;
SET LOCAL ROLE service_role;
SELECT tests.assert_raises(
  $$UPDATE public.expenses SET group_id = '10000000-0000-4000-8000-000000000002'
     WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  'P0001', 'service_role cannot move an expense to another group', 'immutable_field');
SELECT tests.assert_raises(
  $$UPDATE public.expenses SET created_by = '00000000-0000-4000-8000-00000000000b'
     WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  'P0001', 'service_role cannot reassign created_by', 'immutable_field');
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
RESET ROLE;
SET LOCAL ROLE postgres;
SELECT tests.assert_raises(
  $$UPDATE public.expenses SET group_id = '10000000-0000-4000-8000-000000000002'
     WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  'P0001', 'postgres (dashboard SQL) cannot move an expense', 'immutable_field');
SELECT tests.assert_ok(
  $$UPDATE public.expenses SET description = 'Weekly groceries'
     WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  'non-identity columns remain editable');
ROLLBACK;

-- Since M8, authenticated has USAGE on private for the RLS helpers only.
SELECT tests.assert(
  NOT has_schema_privilege('anon', 'private', 'USAGE'),
  'private schema is not usable by anon');
SELECT tests.assert(
  NOT has_function_privilege('authenticated', 'private.guard_expense_immutables()', 'EXECUTE'),
  'guard function is not executable by clients');
