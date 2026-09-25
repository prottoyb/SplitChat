-- Anonymous (anon key, no JWT) access. QS-2, QS-5, QS-8.
BEGIN;
SELECT tests.logout();
SET LOCAL ROLE anon;

SELECT tests.assert_raises(
  $$SELECT public.split_chat_is_group_member('10000000-0000-4000-8000-000000000001',
                                             '00000000-0000-4000-8000-00000000000b')$$,
  '42501', 'FIXED[M2]: anon can no longer probe group membership');
SELECT tests.assert_eq((SELECT count(*) FROM public.expenses), 0::bigint, 'anon sees no expenses (RLS)');
SELECT tests.assert_eq((SELECT count(*) FROM public.profiles), 0::bigint, 'anon sees no profiles (RLS)');
SELECT tests.assert_raises('SELECT count(*) FROM public.groups', '42501', 'anon has no privilege on groups');
SELECT tests.assert_raises(
  $$SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'x', 1.00, current_date,
    '00000000-0000-4000-8000-00000000000a', ARRAY['00000000-0000-4000-8000-00000000000a']::uuid[])$$,
  '42501', 'FIXED[M2]: anon cannot execute the expense RPC at all');
ROLLBACK;

SELECT tests.assert(has_table_privilege('anon', 'public.expenses', 'TRUNCATE'),
  'KNOWN-BAD[M3]: anon holds TRUNCATE on expenses');
SELECT tests.assert(has_table_privilege('authenticated', 'public.profiles', 'TRUNCATE'),
  'KNOWN-BAD[M6]: authenticated holds TRUNCATE on profiles');
SELECT tests.assert(
  NOT has_function_privilege('anon', 'public.create_equal_split_expense(uuid,text,numeric,date,uuid,uuid[],text)', 'EXECUTE'),
  'FIXED[M2]: anon may not execute create_equal_split_expense');
