-- Anonymous (anon key, no JWT) access. QS-2, QS-5, QS-8.
BEGIN;
SELECT tests.logout();
SET LOCAL ROLE anon;

SELECT tests.assert(to_regprocedure('public.split_chat_is_group_member(uuid,uuid)') IS NULL,
  'FIXED[M2,M8]: the membership oracle no longer exists');
SELECT tests.assert_raises('SELECT count(*) FROM public.expenses', '42501', 'FIXED[M3]: anon has no privilege on expenses');
SELECT tests.assert_raises('SELECT count(*) FROM public.profiles', '42501', 'FIXED[M6]: anon has no privilege on profiles');
SELECT tests.assert_raises('SELECT count(*) FROM public.groups', '42501', 'anon has no privilege on groups');
SELECT tests.assert_raises(
  $$SELECT public.create_equal_split_expense_v2('10000000-0000-4000-8000-000000000001', 'x', 100, current_date,
    '00000000-0000-4000-8000-00000000000a', ARRAY['00000000-0000-4000-8000-00000000000a']::uuid[])$$,
  '42501', 'FIXED[M2]: anon cannot execute the expense RPC at all (v2 since M12; legacy dropped in M14)');
ROLLBACK;

SELECT tests.assert(NOT has_table_privilege('anon', 'public.expenses', 'TRUNCATE'),
  'FIXED[M3]: anon no longer holds TRUNCATE on expenses');
SELECT tests.assert(NOT has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE'),
  'FIXED[M6]: authenticated no longer holds TRUNCATE on profiles');
SELECT tests.assert(
  NOT has_function_privilege('anon', 'public.create_equal_split_expense_v2(uuid,text,bigint,date,uuid,uuid[],text)', 'EXECUTE'),
  'FIXED[M2]: anon may not execute the expense RPC (v2 since M12; legacy dropped in M14)');
