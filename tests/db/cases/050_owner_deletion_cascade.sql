-- QS-4: deleting an owner's auth account used to destroy other members'
-- ledger rows. FIXED[M5] interim (refused by FK), FIXED[M11] final: refused
-- by the ownership rule; members with history can delete their account while
-- the ledger is kept (see 170).
BEGIN;
SET LOCAL ROLE supabase_auth_admin;   -- as GoTrue does
SELECT tests.assert_raises(
  $$DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-00000000000d'$$,  -- Dan: G2 owner
  'P0001', 'FIXED[M11]: deleting the owner of a shared group is refused', 'owner_must_transfer');
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
SELECT tests.assert_ok(
  $$DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-00000000000b'$$,
  'FIXED[M11]: a member with ledger history can delete their account');
ROLLBACK;

-- A user with no groups and no ledger rows can still be deleted.
BEGIN;
SET LOCAL ROLE supabase_auth_admin;
SELECT tests.assert_ok(
  $$DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-00000000000f'$$,
  'an account with no groups or ledger rows can be deleted');
ROLLBACK;
