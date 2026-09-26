-- M6 regression: least-privilege grants (QS-5, QS-9) and default privileges.

-- anon has no table privileges at all.
SELECT tests.assert(
  NOT EXISTS (SELECT 1 FROM pg_class c
               CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
               WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
                 AND has_table_privilege('anon', c.oid, p)),
  'anon holds no privilege on any public table');
-- Nobody but service_role holds TRUNCATE / REFERENCES / TRIGGER.
SELECT tests.assert(
  NOT EXISTS (SELECT 1 FROM pg_class c
               CROSS JOIN unnest(ARRAY['TRUNCATE','REFERENCES','TRIGGER']) p
               WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
                 AND has_table_privilege('authenticated', c.oid, p)),
  'authenticated holds no TRUNCATE/REFERENCES/TRIGGER');

BEGIN;
SELECT tests.logout();
SET LOCAL ROLE anon;
SELECT tests.assert_raises('SELECT count(*) FROM public.profiles', '42501', 'anon cannot read profiles');
ROLLBACK;

-- The frontend's group-creation insert still works; anything else is refused.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000c');
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok(
  $$INSERT INTO public.groups (name, description, created_by)
    VALUES ('Cara club', NULL, '00000000-0000-4000-8000-00000000000c')$$,
  'member creates a group with the frontend column set');
SELECT tests.assert_raises(
  $$INSERT INTO public.groups (name, created_by, created_at)
    VALUES ('Backdated', '00000000-0000-4000-8000-00000000000c', '2000-01-01')$$,
  '42501', 'cannot set other group columns on insert');
SELECT tests.assert_raises(
  $$INSERT INTO public.groups (name, created_by) VALUES ('Forged', '00000000-0000-4000-8000-00000000000a')$$,
  '42501', 'cannot create a group on behalf of someone else (RLS)');
ROLLBACK;

-- Owners lose direct UPDATE/DELETE of groups and direct INSERT of members.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');  -- Alice owns G1
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises(
  $$UPDATE public.groups SET name = 'Renamed' WHERE id = '10000000-0000-4000-8000-000000000001'$$,
  '42501', 'owner cannot update the group directly');
SELECT tests.assert_raises(
  $$DELETE FROM public.groups WHERE id = '10000000-0000-4000-8000-000000000001'$$,
  '42501', 'owner cannot delete the group directly (no cascade of the ledger)');
SELECT tests.assert_raises(
  $$INSERT INTO public.group_members (group_id, user_id)
    VALUES ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000d')$$,
  '42501', 'owner cannot insert a membership directly');
SELECT tests.assert_raises(
  $$UPDATE public.group_members SET role = 'owner'
     WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000b'$$,
  '42501', 'nobody can update a membership directly');
ROLLBACK;

-- Profiles: only full_name/avatar_url of one's own profile.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000b');
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok(
  $$UPDATE public.profiles SET full_name = 'Bobby' WHERE id = '00000000-0000-4000-8000-00000000000b'$$,
  'user updates own display name');
WITH changed AS (UPDATE public.profiles SET full_name = 'Hacked'
                  WHERE id = '00000000-0000-4000-8000-00000000000a' RETURNING 1)
SELECT tests.assert_eq((SELECT count(*) FROM changed), 0::bigint, 'user cannot update another profile (RLS)');
SELECT tests.assert_raises(
  $$UPDATE public.profiles SET created_at = now() WHERE id = '00000000-0000-4000-8000-00000000000b'$$,
  '42501', 'user cannot update other profile columns');
SELECT tests.assert_raises(
  $$DELETE FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000000000b'$$,
  '42501', 'user cannot delete a profile');
ROLLBACK;

-- New objects created by postgres are not auto-granted to clients.
BEGIN;
SET LOCAL ROLE postgres;
CREATE TABLE public.m6_probe (id int);
CREATE FUNCTION public.m6_probe_fn() RETURNS int LANGUAGE sql AS 'SELECT 1';
RESET ROLE;
SELECT tests.assert(
  NOT has_table_privilege('anon', 'public.m6_probe', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.m6_probe', 'SELECT'),
  'new tables are not granted to client roles by default');
SELECT tests.assert(
  NOT has_function_privilege('anon', 'public.m6_probe_fn()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.m6_probe_fn()', 'EXECUTE'),
  'new functions are not executable by client roles (or PUBLIC) by default');
ROLLBACK;
