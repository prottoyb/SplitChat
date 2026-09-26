-- M9 regression: authorization-first membership RPCs (QS-6, DS-1, DS-4, CA-1).
-- Actors: Alice = G1 owner; Bob, Eve = G1 members; Cara = outsider to G1
-- (member of G2); Dan = G2 owner; Uma = unconfirmed email, no groups.

-- ---------------------------------------------------------------- add by email
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq(
  (SELECT row(result, added_user_id, added_full_name, added_role)::text
     FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', ' CARA@example.test ')),
  row('added', '00000000-0000-4000-8000-00000000000c'::uuid, 'Cara', 'member')::text,
  'owner adds a confirmed account (case/space-insensitive) and gets its identity');
SELECT tests.assert_eq(
  (SELECT row(result, added_user_id, added_full_name, added_role)::text
     FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'cara@example.test')),
  row('already_member', NULL::uuid, NULL::text, NULL::text)::text,
  'already_member discloses no identity (DS-4)');
SELECT tests.assert_eq(
  (SELECT row(result, added_user_id, added_full_name, added_role)::text
     FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'nobody@example.test')),
  row('member_not_added', NULL::uuid, NULL::text, NULL::text)::text,
  'no account -> member_not_added, no identity');
SELECT tests.assert_eq(
  (SELECT row(result, added_user_id, added_full_name, added_role)::text
     FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'uma@example.test')),
  row('member_not_added', NULL::uuid, NULL::text, NULL::text)::text,
  'unconfirmed account -> identical member_not_added (no enumeration)');
SELECT tests.assert_raises(
  $$SELECT * FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'not-an-email')$$,
  'P0001', 'malformed email -> invalid_email', 'invalid_email');
ROLLBACK;

-- Differential oracle (S9): non-owners and outsiders get the same error for
-- existing vs nonexistent emails and groups.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000b');  -- Bob: member, not owner
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT * FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'cara@example.test')$$,
  'P0001', 'member + existing email -> not_found_or_forbidden', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT * FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'nobody@example.test')$$,
  'P0001', 'member + nonexistent email -> identical error', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT * FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'not-an-email')$$,
  'P0001', 'member + malformed email -> identical error (authorization first)', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.login('00000000-0000-4000-8000-00000000000c');  -- Cara: outsider to G1
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT * FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'cara@example.test')$$,
  'P0001', 'outsider + existing group -> not_found_or_forbidden', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT * FROM public.add_group_member_by_email('10000000-0000-4000-8000-0000000000ff', 'cara@example.test')$$,
  'P0001', 'outsider + nonexistent group -> identical error', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.logout();
SET LOCAL ROLE anon;
SELECT tests.assert_raises($$SELECT * FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'cara@example.test')$$,
  '42501', 'anon cannot call add_group_member_by_email');
ROLLBACK;

-- Rate limit counts failed probes too (CA-1): 20 per hour, then rate_limited.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq(
  (SELECT count(*) FROM generate_series(1, 20) i,
          LATERAL public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'probe' || i || '@example.test') r
    WHERE r.result = 'member_not_added'),
  20::bigint, 'twenty failed probes are answered');
SELECT tests.assert_eq(
  (SELECT result FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'cara@example.test')),
  'rate_limited', 'the 21st attempt in an hour is rate limited, even for a valid email');
SELECT tests.assert_raises($$SELECT count(*) FROM private.member_add_attempts$$,
  '42501', 'clients cannot read the attempt log');
ROLLBACK;

-- ----------------------------------------------------------- remove / leave
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok($$SELECT public.remove_group_member('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b')$$,
  'owner removes Bob');
SELECT tests.assert_raises($$SELECT public.remove_group_member('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b')$$,
  'P0001', 'removing a former member -> member_not_found', 'member_not_found');
SELECT tests.assert_raises($$SELECT public.remove_group_member('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000ff')$$,
  'P0001', 'removing an unknown user -> member_not_found', 'member_not_found');
SELECT tests.assert_raises($$SELECT public.remove_group_member('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000a')$$,
  'P0001', 'owner cannot remove themselves', 'cannot_remove_owner');
RESET ROLE;
SELECT tests.assert_eq(
  (SELECT row(left_reason, removed_by)::text FROM public.group_members
    WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000b'),
  row('removed', '00000000-0000-4000-8000-00000000000a'::uuid)::text, 'removal is recorded, not deleted');
SELECT tests.login('00000000-0000-4000-8000-00000000000b');
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq((SELECT count(*) FROM public.expenses), 0::bigint, 'removed member loses access');
RESET ROLE;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq((SELECT sum(share_amount) FROM public.expense_splits
                         WHERE expense_id = '20000000-0000-4000-8000-000000000001'), 100.00::numeric,
  'removed member''s historical splits remain and still balance');
-- Re-adding a former member reactivates the same row.
SELECT tests.assert_eq(
  (SELECT result FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'bob@example.test')),
  'added', 'former member can be re-added');
RESET ROLE;
SELECT tests.assert_eq(
  (SELECT row(role, left_at, left_reason, removed_by)::text FROM public.group_members
    WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000b'),
  row('member', NULL::timestamptz, NULL::text, NULL::uuid)::text, 're-add clears the leave record');
ROLLBACK;

-- Non-owners: identical errors for existing vs nonexistent targets (S9).
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000b');
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.remove_group_member('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000e')$$,
  'P0001', 'member removing an existing member -> not_found_or_forbidden', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.remove_group_member('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000ff')$$,
  'P0001', 'member removing an unknown user -> identical error', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.remove_group_member('10000000-0000-4000-8000-0000000000ff', '00000000-0000-4000-8000-00000000000e')$$,
  'P0001', 'unknown group -> identical error', 'not_found_or_forbidden');
ROLLBACK;

BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000b');
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok($$SELECT public.leave_group('10000000-0000-4000-8000-000000000001')$$, 'member leaves');
SELECT tests.assert_raises($$SELECT public.leave_group('10000000-0000-4000-8000-000000000001')$$,
  'P0001', 'leaving again -> not_found_or_forbidden', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.assert_eq(
  (SELECT left_reason FROM public.group_members
    WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000b'),
  'left', 'leaving is recorded as left');
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.leave_group('10000000-0000-4000-8000-000000000001')$$,
  'P0001', 'owner cannot leave without transferring', 'owner_must_transfer');
RESET ROLE;
SELECT tests.login('00000000-0000-4000-8000-00000000000c');
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.leave_group('10000000-0000-4000-8000-000000000001')$$,
  'P0001', 'outsider leaving an existing group -> not_found_or_forbidden', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.leave_group('10000000-0000-4000-8000-0000000000ff')$$,
  'P0001', 'leaving an unknown group -> identical error', 'not_found_or_forbidden');
ROLLBACK;

-- ------------------------------------------------------ ownership transfer
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.transfer_group_ownership('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000a')$$,
  'P0001', 'transfer to self -> invalid_new_owner', 'invalid_new_owner');
SELECT tests.assert_raises($$SELECT public.transfer_group_ownership('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000c')$$,
  'P0001', 'transfer to a non-member -> invalid_new_owner', 'invalid_new_owner');
SELECT tests.assert_raises($$SELECT public.transfer_group_ownership('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000ff')$$,
  'P0001', 'transfer to an unknown user -> invalid_new_owner', 'invalid_new_owner');
SELECT tests.assert_ok($$SELECT public.transfer_group_ownership('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b')$$,
  'owner transfers to an active member');
SELECT tests.assert_raises($$SELECT public.transfer_group_ownership('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000e')$$,
  'P0001', 'the previous owner can no longer act as owner', 'not_found_or_forbidden');
SELECT tests.assert_ok($$SELECT public.leave_group('10000000-0000-4000-8000-000000000001')$$,
  'the previous owner can now leave');
RESET ROLE;
SELECT tests.assert_eq(
  (SELECT array_agg(user_id::text || ':' || role ORDER BY user_id) FROM public.group_members
    WHERE group_id = '10000000-0000-4000-8000-000000000001' AND left_at IS NULL),
  ARRAY['00000000-0000-4000-8000-00000000000b:owner', '00000000-0000-4000-8000-00000000000e:member'],
  'exactly one active owner after transfer and leave');
SELECT tests.assert_eq(
  (SELECT created_by FROM public.groups WHERE id = '10000000-0000-4000-8000-000000000001'),
  '00000000-0000-4000-8000-00000000000a'::uuid, 'groups.created_by still records the creator');
SELECT tests.login('00000000-0000-4000-8000-00000000000b');
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq(
  (SELECT result FROM public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'cara@example.test')),
  'added', 'the new owner can add members');
ROLLBACK;

BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000e');  -- Eve: member, not owner
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.transfer_group_ownership('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b')$$,
  'P0001', 'member transferring to an existing member -> not_found_or_forbidden', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.transfer_group_ownership('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000ff')$$,
  'P0001', 'member transferring to an unknown user -> identical error', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.logout();
SET LOCAL ROLE anon;
SELECT tests.assert_raises($$SELECT public.leave_group('10000000-0000-4000-8000-000000000001')$$, '42501', 'anon cannot call leave_group');
SELECT tests.assert_raises($$SELECT public.remove_group_member('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b')$$,
  '42501', 'anon cannot call remove_group_member');
SELECT tests.assert_raises($$SELECT public.transfer_group_ownership('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b')$$,
  '42501', 'anon cannot call transfer_group_ownership');
ROLLBACK;
