-- M4: the deferred balance check fires at a real COMMIT in the caller's
-- role (authenticated, as through PostgREST) and passes for RPC writes.
-- Each case file runs in its own disposable database, so committing is safe.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'Committed dinner', 100.00,
  current_date, '00000000-0000-4000-8000-00000000000a',
  ARRAY['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b',
        '00000000-0000-4000-8000-00000000000e']::uuid[]);
COMMIT;

SELECT tests.assert_eq(
  (SELECT sum(s.share_amount) FROM public.expense_splits s
     JOIN public.expenses e ON e.id = s.expense_id WHERE e.description = 'Committed dinner'),
  100.00::numeric, 'RPC expense committed as authenticated and balances');

-- Since M8 the only client-executable private functions are the three
-- caller-scoped RLS helpers.
SELECT tests.assert(
  NOT EXISTS (SELECT 1 FROM pg_proc p
               WHERE p.pronamespace = 'private'::regnamespace
                 AND (has_function_privilege('anon', p.oid, 'EXECUTE')
                      OR has_function_privilege('service_role', p.oid, 'EXECUTE')
                      OR (has_function_privilege('authenticated', p.oid, 'EXECUTE')
                          AND p.proname NOT IN ('my_active_group_ids', 'my_group_peer_ids', 'my_owned_group_ids')))),
  'private functions: no anon/service_role EXECUTE; authenticated only the RLS helpers');
SELECT tests.assert(
  NOT EXISTS (SELECT 1 FROM pg_proc p
               WHERE p.pronamespace = 'private'::regnamespace
                 AND coalesce(p.proconfig, '{}') <> ARRAY['search_path=""']),
  'every private function pins search_path to empty');
