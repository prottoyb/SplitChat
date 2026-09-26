-- Direct Data API membership writes. The add-by-email behaviour moved to
-- the M9 RPC (see 160).
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');  -- Alice owns G1
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises(
  $$INSERT INTO public.group_members (group_id, user_id) VALUES
    ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000d')$$,
  '42501', 'FIXED[M6]: owner can no longer insert a member by id directly');
WITH gone AS (DELETE FROM public.group_members
  WHERE group_id = '10000000-0000-4000-8000-000000000001'
    AND user_id = '00000000-0000-4000-8000-00000000000a' RETURNING 1)
SELECT tests.assert_eq((SELECT count(*) FROM gone), 0::bigint, 'owner cannot delete their own membership');
RESET ROLE;

SELECT tests.login('00000000-0000-4000-8000-00000000000b');  -- Bob: member of G1
SET LOCAL ROLE authenticated;
WITH gone AS (DELETE FROM public.group_members
  WHERE group_id = '10000000-0000-4000-8000-000000000001'
    AND user_id = '00000000-0000-4000-8000-00000000000b' RETURNING 1)
SELECT tests.assert_eq((SELECT count(*) FROM gone), 1::bigint,
  'KNOWN-BAD[M10]: a direct delete still hard-deletes the membership row');
ROLLBACK;
