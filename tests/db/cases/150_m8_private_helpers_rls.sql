-- M8 regression: private helpers, active-membership RLS, G1 ledger identities.

-- Function surface: exactly the client RPCs remain in public.
SELECT tests.assert_eq(
  (SELECT array_agg(proname::text ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace),
  ARRAY['add_group_member_by_email', 'create_equal_split_expense', 'get_ledger_identities',
        'leave_group', 'remove_group_member', 'transfer_group_ownership'],
  'public exposes only the client RPCs');
SELECT tests.assert(
  NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace IN ('public'::regnamespace, 'private'::regnamespace)
                AND has_function_privilege('anon', oid, 'EXECUTE')),
  'anon can execute no function');
SELECT tests.assert_eq(
  (SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) FROM pg_proc p
    WHERE p.pronamespace IN ('public'::regnamespace, 'private'::regnamespace)
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  ARRAY['add_group_member_by_email(uuid,text)',
        'create_equal_split_expense(uuid,text,numeric,date,uuid,uuid[],text)',
        'get_ledger_identities(uuid)', 'leave_group(uuid)',
        'private.my_active_group_ids()', 'private.my_group_peer_ids()',
        'remove_group_member(uuid,uuid)', 'transfer_group_ownership(uuid,uuid)'],
  'authenticated EXECUTE allowlist (no helper takes an arbitrary user id)');
SELECT tests.assert(
  NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace IN ('public'::regnamespace, 'private'::regnamespace)
                AND prosecdef AND coalesce(proconfig, '{}') <> ARRAY['search_path=""']),
  'every SECURITY DEFINER function pins search_path to empty');

-- Former member E (left G1): loses all access; active members no longer see E.
BEGIN;
UPDATE public.group_members SET left_at = now(), left_reason = 'left'
 WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000e';
SELECT tests.login('00000000-0000-4000-8000-00000000000e');
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq((SELECT count(*) FROM public.groups), 0::bigint, 'former member sees no group');
SELECT tests.assert_eq((SELECT count(*) FROM public.expenses), 0::bigint, 'former member sees no expenses');
SELECT tests.assert_eq((SELECT count(*) FROM public.expense_splits), 0::bigint, 'former member sees no splits');
SELECT tests.assert_eq((SELECT count(*) FROM public.group_members), 0::bigint, 'former member sees no memberships');
SELECT tests.assert_eq((SELECT count(*) FROM public.profiles), 1::bigint, 'former member sees only their own profile');
SELECT tests.assert_raises(
  $$SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'x', 1.00, current_date,
    '00000000-0000-4000-8000-00000000000e', ARRAY['00000000-0000-4000-8000-00000000000e']::uuid[])$$,
  'P0001', 'former member cannot create expenses', 'You do not have access to this group.');
RESET ROLE;

SELECT tests.login('00000000-0000-4000-8000-00000000000b');
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq((SELECT count(*) FROM public.group_members), 2::bigint, 'active member sees active memberships only');
SELECT tests.assert_eq((SELECT count(*) FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000000000e'), 0::bigint,
  'no former-member directory: former member profile not browsable');
SELECT tests.assert_eq((SELECT count(*) FROM public.expense_splits WHERE expense_id = '20000000-0000-4000-8000-000000000002'), 3::bigint,
  'historical splits of the former member remain visible');
SELECT tests.assert_eq(
  (SELECT array_agg(user_id::text || ':' || display_name) FROM public.get_ledger_identities('10000000-0000-4000-8000-000000000001')),
  ARRAY['00000000-0000-4000-8000-00000000000e:Eve'],
  'get_ledger_identities returns only the ledger-referenced former member, name only');
SELECT tests.assert_raises(
  $$SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'x', 3.00, current_date,
    '00000000-0000-4000-8000-00000000000b',
    ARRAY['00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000e']::uuid[])$$,
  'P0001', 'former member cannot be a new participant',
  'One or more selected participants are not members of this group.');
ROLLBACK;

-- G1: a former member with no ledger rows is never returned.
BEGIN;
INSERT INTO public.group_members (group_id, user_id, role, left_at, left_reason)
  VALUES ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000f', 'member', now(), 'left');
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq(
  (SELECT count(*) FROM public.get_ledger_identities('10000000-0000-4000-8000-000000000001')), 0::bigint,
  'former member without ledger rows is not disclosed');
ROLLBACK;

-- Authorization-first with identical errors (S9 differential).
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000c');  -- outsider to G1
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT * FROM public.get_ledger_identities('10000000-0000-4000-8000-000000000001')$$,
  'P0001', 'outsider: existing group -> not_found_or_forbidden', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT * FROM public.get_ledger_identities('10000000-0000-4000-8000-0000000000ff')$$,
  'P0001', 'outsider: nonexistent group -> identical not_found_or_forbidden', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.logout();
SET LOCAL ROLE anon;
SELECT tests.assert_raises($$SELECT * FROM public.get_ledger_identities('10000000-0000-4000-8000-000000000001')$$,
  '42501', 'anon cannot call get_ledger_identities');
SELECT tests.assert_raises($$SELECT * FROM private.my_active_group_ids()$$,
  '42501', 'anon cannot use the private schema');
RESET ROLE;
SELECT tests.login('00000000-0000-4000-8000-00000000000c');
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises(
  $$SELECT private.is_active_member_of('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b')$$,
  '42501', 'authenticated cannot call the internal membership check (no oracle)');
ROLLBACK;

-- Triggers moved to private still fire for their real callers.
BEGIN;
INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at)
  VALUES ('00000000-0000-4000-8000-000000000011', 'ola@example.test', '{"full_name":"Ola"}', now());
SELECT tests.assert_eq((SELECT full_name FROM public.profiles WHERE id = '00000000-0000-4000-8000-000000000011'),
  'Ola', 'profile created by private.handle_new_user');
SELECT tests.login('00000000-0000-4000-8000-000000000011');
SET LOCAL ROLE authenticated;
INSERT INTO public.groups (name, description, created_by) VALUES ('Ola group', NULL, '00000000-0000-4000-8000-000000000011');
SELECT tests.assert_eq((SELECT count(*) FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id
                         WHERE g.name = 'Ola group' AND gm.role = 'owner'), 1::bigint,
  'owner row created by private.handle_new_group');
UPDATE public.profiles SET full_name = 'Ola N' WHERE id = '00000000-0000-4000-8000-000000000011';
SELECT tests.assert((SELECT updated_at >= created_at FROM public.profiles WHERE id = '00000000-0000-4000-8000-000000000011'),
  'private.set_updated_at fires for a signed-in profile update');
ROLLBACK;
