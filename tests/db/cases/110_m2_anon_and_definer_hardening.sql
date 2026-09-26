-- M2 regression (QS-2, QS-8, QS-10) and S8 (triggers still fire).
BEGIN;
SELECT tests.logout();
SET LOCAL ROLE anon;
SELECT tests.assert(to_regprocedure('public.split_chat_is_group_member(uuid,uuid)') IS NULL,
  'membership oracle removed (M2 revoked anon, M8 dropped it)');
SELECT tests.assert_raises(
  $$SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'x', 1.00, current_date,
    '00000000-0000-4000-8000-00000000000a', ARRAY['00000000-0000-4000-8000-00000000000a']::uuid[])$$,
  '42501', 'anon can no longer execute create_equal_split_expense');
ROLLBACK;

-- The app path for signed-in members still works.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000b');
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok(
  $$SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'Taxi', 12.00, current_date,
    '00000000-0000-4000-8000-00000000000b',
    ARRAY['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b']::uuid[])$$,
  'member can still create an expense after search_path hardening');
ROLLBACK;

-- No SECURITY DEFINER function in public is executable by anon, and each
-- has a pinned, empty search_path.
SELECT tests.assert(
  NOT EXISTS (SELECT 1 FROM pg_proc p
               WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
                 AND has_function_privilege('anon', p.oid, 'EXECUTE')),
  'no public SECURITY DEFINER function is executable by anon');
SELECT tests.assert(
  NOT EXISTS (SELECT 1 FROM pg_proc p
               WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
                 AND coalesce(p.proconfig, '{}') <> ARRAY['search_path=""']),
  'every public SECURITY DEFINER function has search_path=''''');
SELECT tests.assert(
  NOT has_function_privilege('authenticated', 'private.handle_new_user()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'private.set_updated_at()', 'EXECUTE'),
  'trigger functions are not executable by clients');

-- S8: triggers still fire although clients hold no EXECUTE on them.
BEGIN;
INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  VALUES ('00000000-0000-4000-8000-000000000010', 'nia@example.test', '{"full_name":"Nia"}', now());
SELECT tests.assert_eq((SELECT full_name FROM public.profiles WHERE id = '00000000-0000-4000-8000-000000000010'),
  'Nia', 'on_auth_user_created still creates the profile');

SELECT tests.login('00000000-0000-4000-8000-000000000010');
SET LOCAL ROLE authenticated;
INSERT INTO public.groups (name, description, created_by)
  VALUES ('Book club', NULL, '00000000-0000-4000-8000-000000000010');
SELECT tests.assert_eq(
  (SELECT gm.role FROM public.group_members gm
     JOIN public.groups g ON g.id = gm.group_id
    WHERE g.name = 'Book club' AND gm.user_id = '00000000-0000-4000-8000-000000000010'),
  'owner', 'on_group_created still adds the owner row');
RESET ROLE;

UPDATE public.expenses SET updated_at = '2000-01-01', description = 'Groceries'
 WHERE id = '20000000-0000-4000-8000-000000000001';
SELECT tests.assert(
  (SELECT updated_at > '2000-01-02' FROM public.expenses WHERE id = '20000000-0000-4000-8000-000000000001'),
  'expenses_set_updated_at still maintains updated_at');
ROLLBACK;
