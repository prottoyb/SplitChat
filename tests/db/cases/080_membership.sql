-- Direct Data API membership writes are all refused after M6 and M10.
-- Membership changes go through the M9 RPCs (see 160).
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');  -- Alice owns G1
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises(
  $$INSERT INTO public.group_members (group_id, user_id) VALUES
    ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000d')$$,
  '42501', 'FIXED[M6]: owner can no longer insert a member by id directly');
SELECT tests.assert_raises(
  $$DELETE FROM public.group_members
     WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000b'$$,
  '42501', 'FIXED[M10]: owner can no longer hard-delete a membership');
RESET ROLE;

SELECT tests.login('00000000-0000-4000-8000-00000000000b');  -- Bob: member of G1
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises(
  $$DELETE FROM public.group_members
     WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000b'$$,
  '42501', 'FIXED[M10]: a member can no longer hard-delete their membership (leave_group records history)');
ROLLBACK;

SELECT tests.assert(
  NOT EXISTS (SELECT 1 FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p
               WHERE has_table_privilege('authenticated', 'public.group_members', p)),
  'authenticated holds no write privilege on group_members');
SELECT tests.assert(
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'group_members' AND cmd <> 'SELECT'),
  'group_members has only a SELECT policy');
