-- QS-4: deleting an owner's auth account used to destroy other members'
-- ledger rows. FIXED[M5] (interim): owner deletion is refused instead;
-- M11 replaces this with ledger-preserving deletion.
BEGIN;
SET LOCAL ROLE supabase_auth_admin;   -- as GoTrue does
SELECT tests.assert_raises(
  $$DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-00000000000d'$$,  -- Dan: G2 owner
  '23503', 'FIXED[M5]: deleting owner Dan is refused by groups_created_by_fkey (RESTRICT)',
  'update or delete on table "users" violates foreign key constraint "groups_created_by_fkey" on table "groups"');
RESET ROLE;
SELECT tests.assert_eq(
  (SELECT count(*) FROM public.expenses WHERE id = '20000000-0000-4000-8000-000000000003'),
  1::bigint, 'FIXED[M5]: the expense X3 created by Cara survives');
SELECT tests.assert_eq(
  (SELECT count(*) FROM auth.users WHERE id = '00000000-0000-4000-8000-00000000000d'),
  1::bigint, 'the refused deletion changed nothing');
ROLLBACK;

BEGIN;
SET LOCAL ROLE supabase_auth_admin;
SELECT tests.assert_raises(
  $$DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-00000000000b'$$,
  '23503', 'KNOWN-BAD[M11]: a member with ledger history cannot delete their account');
ROLLBACK;

-- A user with no groups and no ledger rows can still be deleted.
BEGIN;
SET LOCAL ROLE supabase_auth_admin;
SELECT tests.assert_ok(
  $$DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-00000000000f'$$,
  'an account with no groups or ledger rows can be deleted');
ROLLBACK;
