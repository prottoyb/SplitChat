-- M11 regression: ledger-preserving account deletion (QS-4 final, DS-2).
-- Deletions run as supabase_auth_admin, the role GoTrue uses. The real
-- GoTrue path is proven on SplitChat-Dev (CA-2).
-- Seed: G1 owner Alice (members Bob, Eve); G2 owner Dan (members Cara, Alice);
-- Uma has no groups.

-- Member with ledger history (Bob): allowed; profile tombstoned; ledger intact.
BEGIN;
SET LOCAL ROLE supabase_auth_admin;
SELECT tests.assert_ok($$DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-00000000000b'$$,
  'member with ledger history can delete their account');
RESET ROLE;
SELECT tests.assert_eq(
  (SELECT row(full_name, avatar_url, deleted_at IS NOT NULL)::text FROM public.profiles
    WHERE id = '00000000-0000-4000-8000-00000000000b'),
  row('Deleted user', NULL::text, true)::text, 'profile is tombstoned, not deleted');
SELECT tests.assert_eq(
  (SELECT row(left_reason, left_at IS NOT NULL, role)::text FROM public.group_members
    WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000b'),
  row('account_deleted', true, 'member')::text, 'membership marked account_deleted');
SELECT tests.assert_eq(
  (SELECT count(*) FROM public.expense_splits WHERE user_id = '00000000-0000-4000-8000-00000000000b'), 2::bigint,
  'the deleted user''s splits are kept');
SELECT tests.assert_eq(
  (SELECT count(*) FROM public.expenses WHERE paid_by = '00000000-0000-4000-8000-00000000000b'), 1::bigint,
  'expenses the deleted user paid are kept');
SELECT tests.assert_eq(
  (SELECT sum(share_amount) FROM public.expense_splits WHERE expense_id = '20000000-0000-4000-8000-000000000002'),
  10.00::numeric, 'their expense still balances');
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq(
  (SELECT display_name FROM public.get_ledger_identities('10000000-0000-4000-8000-000000000001')
    WHERE user_id = '00000000-0000-4000-8000-00000000000b'),
  'Deleted user', 'history shows the tombstone name, nothing else');
ROLLBACK;

-- Owner of a multi-member group (Alice owns G1): refused; nothing changes.
BEGIN;
SET LOCAL ROLE supabase_auth_admin;
SELECT tests.assert_raises($$DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-00000000000a'$$,
  'P0001', 'owner of a shared group cannot delete their account', 'owner_must_transfer');
RESET ROLE;
SELECT tests.assert_eq((SELECT count(*) FROM auth.users WHERE id = '00000000-0000-4000-8000-00000000000a'), 1::bigint,
  'blocked deletion leaves the auth user');
SELECT tests.assert_eq((SELECT deleted_at FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000000000a'),
  NULL::timestamptz, 'blocked deletion leaves the profile untouched');
SELECT tests.assert_eq((SELECT count(*) FROM public.group_members
                         WHERE user_id = '00000000-0000-4000-8000-00000000000a' AND left_at IS NULL), 2::bigint,
  'blocked deletion leaves memberships active');
ROLLBACK;

-- Former owner who transferred can delete; the group keeps its creator audit.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT public.transfer_group_ownership('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b');
RESET ROLE;
SET LOCAL ROLE supabase_auth_admin;
SELECT tests.assert_ok($$DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-00000000000a'$$,
  'after transferring, the former owner (and group creator) can delete their account');
RESET ROLE;
SELECT tests.assert_eq((SELECT created_by FROM public.groups WHERE id = '10000000-0000-4000-8000-000000000001'),
  '00000000-0000-4000-8000-00000000000a'::uuid, 'the group keeps its creator audit (tombstoned profile)');
SELECT tests.assert_eq((SELECT count(*) FROM public.expenses WHERE group_id = '10000000-0000-4000-8000-000000000001'),
  2::bigint, 'the group ledger is intact');
ROLLBACK;

-- Sole owner of a sole-member group: allowed; the group persists, orphaned.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000f');
SET LOCAL ROLE authenticated;
INSERT INTO public.groups (name, description, created_by) VALUES ('Uma solo', NULL, '00000000-0000-4000-8000-00000000000f');
RESET ROLE;
SET LOCAL ROLE supabase_auth_admin;
SELECT tests.assert_ok($$DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-00000000000f'$$,
  'sole owner of a sole-member group can delete their account');
RESET ROLE;
SELECT tests.assert_eq(
  (SELECT row(gm.role, gm.left_reason)::text FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id
    WHERE g.name = 'Uma solo'),
  row('member', 'account_deleted')::text, 'sole owner is demoted and marked left; the group persists');
ROLLBACK;

-- Operator ownership release (DS-2): postgres only.
BEGIN;
SET LOCAL ROLE postgres;
SELECT tests.assert_eq(
  (SELECT array_agg(new_owner_id::text) FROM private.admin_release_ownership('00000000-0000-4000-8000-00000000000a')),
  ARRAY['00000000-0000-4000-8000-00000000000b'], 'ownership goes to the longest-standing active member');
RESET ROLE;
SELECT tests.assert_eq((SELECT count(*) FROM public.group_members
                         WHERE group_id = '10000000-0000-4000-8000-000000000001' AND role = 'owner' AND left_at IS NULL),
  1::bigint, 'exactly one active owner after release');
SET LOCAL ROLE supabase_auth_admin;
SELECT tests.assert_ok($$DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-00000000000a'$$,
  'after operator release, the deletion succeeds');
ROLLBACK;

BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT * FROM private.admin_release_ownership('00000000-0000-4000-8000-00000000000a')$$,
  '42501', 'clients cannot call admin_release_ownership');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT tests.assert_raises($$SELECT * FROM private.admin_release_ownership('00000000-0000-4000-8000-00000000000a')$$,
  '42501', 'service_role cannot call admin_release_ownership');
ROLLBACK;

-- Deleting a group directly no longer cascades its ledger (FK RESTRICT).
BEGIN;
SET LOCAL ROLE postgres;
SELECT tests.assert_raises($$DELETE FROM public.groups WHERE id = '10000000-0000-4000-8000-000000000002'$$,
  '23503', 'a group with expenses cannot be deleted by cascade');
ROLLBACK;
