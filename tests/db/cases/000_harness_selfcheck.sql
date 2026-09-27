-- Harness self-check: helpers behave, fixture loaded, identities switch.
SELECT tests.assert(true, 'assert passes on true');
SELECT tests.assert_raises($$SELECT tests.assert(false, 'x')$$, 'P0001', 'assert raises on false');
SELECT tests.assert_eq((SELECT count(*) FROM auth.users), 6::bigint, 'six seeded auth users');
SELECT tests.assert_eq((SELECT count(*) FROM public.profiles), 6::bigint, 'profiles created by on_auth_user_created');
SELECT tests.assert_eq((SELECT count(*) FROM public.group_members WHERE role = 'owner'), 2::bigint, 'owner rows created by on_group_created');

BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq(auth.uid(), '00000000-0000-4000-8000-00000000000a'::uuid, 'auth.uid() follows tests.login');
SELECT tests.assert_eq(current_user::text, 'authenticated', 'SET LOCAL ROLE authenticated');
ROLLBACK;
