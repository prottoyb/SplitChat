-- QS-4: deleting an owner's auth account destroys other members' ledger rows.
BEGIN;
SET LOCAL ROLE supabase_auth_admin;   -- as GoTrue does
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-00000000000d';  -- Dan: G2 owner, no ledger rows
RESET ROLE;
SELECT tests.assert_eq(
  (SELECT count(*) FROM public.expenses WHERE id = '20000000-0000-4000-8000-000000000003'),
  0::bigint, 'KNOWN-BAD[M5]: deleting owner Dan cascaded away the expense X3 created by Cara');
ROLLBACK;

BEGIN;
SET LOCAL ROLE supabase_auth_admin;
SELECT tests.assert_raises(
  $$DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-00000000000b'$$,
  '23503', 'KNOWN-BAD[M11]: a member with ledger history cannot delete their account');
ROLLBACK;
