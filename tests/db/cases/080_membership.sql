-- Membership behaviour as in production. QS-6, QS-9.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');  -- Alice owns G1
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises(
  $$SELECT * FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'nobody@example.test')$$,
  'P0001', 'KNOWN-BAD[M9]: owner learns that an email has no account',
  'No SplitChat account was found for that email address.');
SELECT tests.assert_ok(
  $$SELECT * FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'uma@example.test')$$,
  'KNOWN-BAD[M9]: owner can add an account whose email is unconfirmed');
SELECT tests.assert_ok(
  $$SELECT * FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'CARA@example.test')$$,
  'owner adds an existing account by email (case-insensitive)');
SELECT tests.assert_raises(
  $$SELECT * FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'cara@example.test')$$,
  'P0001', 'duplicate membership rejected', 'This user is already a member of the group.');
SELECT tests.assert_ok(
  $$INSERT INTO public.group_members (group_id, user_id) VALUES
    ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000d')$$,
  'KNOWN-BAD[M6]: owner inserts a member by id directly, bypassing the RPC');
RESET ROLE;

SELECT tests.login('00000000-0000-4000-8000-00000000000b');  -- Bob: member of G1
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises(
  $$SELECT * FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'nobody@example.test')$$,
  'P0001', 'non-owner rejected before any email lookup', 'Only the group owner can add members.');
WITH gone AS (DELETE FROM public.group_members
  WHERE group_id = '10000000-0000-4000-8000-000000000001'
    AND user_id = '00000000-0000-4000-8000-00000000000b' RETURNING 1)
SELECT tests.assert_eq((SELECT count(*) FROM gone), 1::bigint, 'KNOWN-BAD[M7]: leaving hard-deletes the membership row');
RESET ROLE;

SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
WITH gone AS (DELETE FROM public.group_members
  WHERE group_id = '10000000-0000-4000-8000-000000000001'
    AND user_id = '00000000-0000-4000-8000-00000000000a' RETURNING 1)
SELECT tests.assert_eq((SELECT count(*) FROM gone), 0::bigint, 'owner cannot delete their own membership');
ROLLBACK;
