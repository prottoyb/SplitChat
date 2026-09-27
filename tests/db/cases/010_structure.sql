-- Baseline structure: RLS on every table, expected policy/function surface.
SELECT tests.assert(
  (SELECT bool_and(relrowsecurity) FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'),
  'RLS enabled on every public table');
SELECT tests.assert_eq(
  (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'),
  6::bigint, 'six public tables (+group_events in M16)');
-- Exact counts on purpose: any migration that changes the policy set must
-- update them. History: 17 at baseline; M3 dropped 6 ledger write policies;
-- M6 dropped 3 owner write policies; M10 dropped the direct membership delete;
-- M16 added the group_events read policy.
SELECT tests.assert_eq((SELECT count(*) FROM pg_policies WHERE schemaname = 'public'), 8::bigint,
  'eight public policies');
SELECT tests.assert_eq((SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace), 9::bigint,
  'nine public functions (client RPCs only: 3 after M8, +3 membership RPCs in M9, +v2 expense RPC in M12, +update/delete in M13, +delete_group in M15, -legacy expense RPC in M14)');
SELECT tests.assert(
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created' AND tgrelid = 'auth.users'::regclass),
  'on_auth_user_created trigger exists on auth.users');
