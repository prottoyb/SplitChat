-- Legacy create_equal_split_expense (numeric amount). Characterised at the
-- baseline; M12 made it a wrapper around create_equal_split_expense_v2
-- (ADR-0006, design §A7), so it allocates in canonical order and raises v2's
-- stable error codes; M14 drops it.
SELECT tests.assert(to_regprocedure('public.create_equal_split_expense(uuid,text,numeric,date,uuid,uuid[],text)') IS NULL,
  'FIXED[M14]: the legacy numeric expense RPC no longer exists');

-- The wrapper's behaviour between M12 and M14 (production batch 3a until 3b):
-- it is restored inside this transaction by the reviewed M14 rollback.
BEGIN;
SET LOCAL ROLE postgres;
\ir ../../../supabase/rollbacks/20260927140000_drop_legacy_expense_rpc.down.sql
RESET ROLE;
SELECT tests.login('00000000-0000-4000-8000-00000000000b');
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE new_expense AS
SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'Pizza', 10.00, current_date,
  '00000000-0000-4000-8000-00000000000b',
  ARRAY['00000000-0000-4000-8000-00000000000e', '00000000-0000-4000-8000-00000000000a',
        '00000000-0000-4000-8000-00000000000b']::uuid[]) AS id;
SELECT tests.assert_eq(
  (SELECT sum(share_amount) FROM public.expense_splits WHERE expense_id = (SELECT id FROM new_expense)),
  10.00::numeric, 'splits sum to the amount');
-- Was KNOWN-BAD[M12]: the remainder cent followed input order (Eve, listed
-- first, got 3.34). The canonical rule gives it to the lowest UUID (Alice).
SELECT tests.assert_eq(
  (SELECT array_agg(share_amount ORDER BY user_id) FROM public.expense_splits
    WHERE expense_id = (SELECT id FROM new_expense)),
  ARRAY[3.34, 3.33, 3.33]::numeric[], 'FIXED[M12]: remainder cent goes to the canonically first participant (Alice), not the first listed (Eve)');
-- The legacy RPC always removed duplicate and null participants; it still does.
CREATE TEMP TABLE dup_expense AS
SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'Dup', 1.00, current_date,
  '00000000-0000-4000-8000-00000000000b',
  ARRAY['00000000-0000-4000-8000-00000000000b', NULL, '00000000-0000-4000-8000-00000000000b',
        '00000000-0000-4000-8000-00000000000a']::uuid[]) AS id;
SELECT tests.assert_eq(
  (SELECT array_agg(share_amount ORDER BY user_id) FROM public.expense_splits
    WHERE expense_id = (SELECT id FROM dup_expense)),
  ARRAY[0.50, 0.50]::numeric[], 'legacy wrapper still removes duplicate and null participants');
SELECT tests.assert_raises(
  $$SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'x', 1.00, current_date,
    '00000000-0000-4000-8000-00000000000b', ARRAY['00000000-0000-4000-8000-00000000000c']::uuid[])$$,
  'P0001', 'CHANGED[M12]: non-member participant rejected with a stable code', 'invalid_participants');
SELECT tests.assert_raises(
  $$SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'x', 1.005, current_date,
    '00000000-0000-4000-8000-00000000000b', ARRAY['00000000-0000-4000-8000-00000000000b']::uuid[])$$,
  'P0001', 'CHANGED[M12]: more than two decimals rejected with a stable code', 'invalid_amount');
SELECT tests.assert_raises(
  $$SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'x', 99999999999999999999, current_date,
    '00000000-0000-4000-8000-00000000000b', ARRAY['00000000-0000-4000-8000-00000000000b']::uuid[])$$,
  'P0001', 'out-of-range amount is invalid_amount, never a raw overflow', 'invalid_amount');
SELECT tests.assert_raises(
  $$SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'x', 0, current_date,
    '00000000-0000-4000-8000-00000000000b', ARRAY['00000000-0000-4000-8000-00000000000b']::uuid[])$$,
  'P0001', 'zero amount rejected', 'invalid_amount');
RESET ROLE;

SELECT tests.login('00000000-0000-4000-8000-00000000000c');
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises(
  $$SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'x', 1.00, current_date,
    '00000000-0000-4000-8000-00000000000c', ARRAY['00000000-0000-4000-8000-00000000000c']::uuid[])$$,
  'P0001', 'CHANGED[M12]: non-member caller rejected with a stable code', 'not_found_or_forbidden');
-- Authorization precedes amount validation: an outsider learns nothing from a bad amount.
SELECT tests.assert_raises(
  $$SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'x', 1.005, current_date,
    '00000000-0000-4000-8000-00000000000c', ARRAY['00000000-0000-4000-8000-00000000000c']::uuid[])$$,
  'P0001', 'outsider with an invalid amount still gets not_found_or_forbidden', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.logout();
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises(
  $$SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'x', 1.005, current_date,
    '00000000-0000-4000-8000-00000000000b', ARRAY['00000000-0000-4000-8000-00000000000b']::uuid[])$$,
  'P0001', 'no session: auth_required before amount validation', 'auth_required');
ROLLBACK;
