-- M7 regression: membership lifecycle constraints and one active owner.
BEGIN;
SET LOCAL ROLE postgres;
-- A second active owner is impossible.
SELECT tests.assert_raises(
  $$UPDATE public.group_members SET role = 'owner'
     WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000b'$$,
  '23505', 'a group cannot have two active owners');
-- An owner row can never be marked as left.
SELECT tests.assert_raises(
  $$UPDATE public.group_members SET left_at = now(), left_reason = 'left'
     WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000a'$$,
  '23514', 'an owner cannot be marked as left');
-- left_at and left_reason go together; reasons are constrained.
SELECT tests.assert_raises(
  $$UPDATE public.group_members SET left_at = now()
     WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000b'$$,
  '23514', 'left_at without left_reason is rejected');
SELECT tests.assert_raises(
  $$UPDATE public.group_members SET left_at = now(), left_reason = 'banished'
     WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000b'$$,
  '23514', 'unknown left_reason is rejected');
SELECT tests.assert_raises(
  $$UPDATE public.group_members SET left_at = now(), left_reason = 'left',
                                    removed_by = '00000000-0000-4000-8000-00000000000a'
     WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000b'$$,
  '23514', 'removed_by only accompanies left_reason removed');
SELECT tests.assert_ok(
  $$UPDATE public.group_members SET left_at = now(), left_reason = 'removed',
                                    removed_by = '00000000-0000-4000-8000-00000000000a'
     WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000b'$$,
  'a member can be marked as removed by the owner');
-- Demote-then-promote transfer keeps exactly one active owner.
SELECT tests.assert_ok($t$DO $b$ BEGIN
    UPDATE public.group_members SET role = 'member'
     WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000a';
    UPDATE public.group_members SET role = 'owner'
     WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000e';
  END $b$ $t$, 'ownership can move to another active member');
-- groups identity columns are immutable.
SELECT tests.assert_raises(
  $$UPDATE public.groups SET created_by = '00000000-0000-4000-8000-00000000000b'
     WHERE id = '10000000-0000-4000-8000-000000000001'$$,
  'P0001', 'groups.created_by is immutable', 'immutable_field');
SELECT tests.assert_ok(
  $$UPDATE public.groups SET name = 'Flat (renamed)' WHERE id = '10000000-0000-4000-8000-000000000001'$$,
  'other group columns remain editable by privileged roles');
ROLLBACK;

SELECT tests.assert_eq(
  (SELECT count(*) FROM public.group_members WHERE left_at IS NOT NULL), 0::bigint,
  'existing memberships stay active after M7');
