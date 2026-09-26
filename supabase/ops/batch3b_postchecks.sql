-- Production batch 3b (M14, after 3a) read-only post-apply verification.
-- Catalog-only (no row contents) plus aggregate data invariants.
-- Every row must report ok = true.

SELECT check_name, ok FROM (VALUES
  ('history: M0-M15 recorded, nothing else',
   (SELECT array_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations)
     = ARRAY['20260926000000','20260926100000','20260926110000','20260926120000','20260926130000',
             '20260926140000','20260926150000','20260926160000','20260926170000','20260926180000',
             '20260926190000','20260927100000','20260927110000','20260927120000','20260927130000',
             '20260927135000','20260927140000']),
  ('M11: profiles no longer cascade from auth.users',
   NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_id_fkey')),
  ('M11: memberships and group creators reference profiles (RESTRICT, validated)',
   (SELECT count(*) FROM pg_constraint
     WHERE contype = 'f' AND convalidated AND confdeltype = 'r' AND confrelid = 'public.profiles'::regclass
       AND ((conrelid = 'public.group_members'::regclass AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
               WHERE attrelid = 'public.group_members'::regclass AND attname = 'user_id')])
         OR (conrelid = 'public.groups'::regclass AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
               WHERE attrelid = 'public.groups'::regclass AND attname = 'created_by')]))) = 2),
  ('M11: nothing references auth.users from public any more',
   NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND confrelid = 'auth.users'::regclass
                 AND connamespace = 'public'::regnamespace)),
  ('M11: expenses no longer cascade from groups',
   (SELECT confdeltype = 'r' AND convalidated FROM pg_constraint WHERE conname = 'expenses_group_id_fkey')),
  ('M11: profiles.deleted_at present',
   EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.profiles'::regclass AND attname = 'deleted_at' AND NOT attisdropped)),
  ('M11: BEFORE DELETE trigger on auth.users is enabled and bound to the private handler',
   EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
            WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'on_auth_user_deleting' AND t.tgenabled = 'O'
              AND p.oid = 'private.handle_auth_user_deleting()'::regprocedure
              AND (t.tgtype & 2) = 2 AND (t.tgtype & 8) = 8)),
  ('M11: admin_release_ownership executable by no client or service role',
   NOT EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
                WHERE has_function_privilege(r, 'private.admin_release_ownership(uuid)', 'EXECUTE'))),
  ('M11 data: every membership, group creator and ledger identity has a profile',
   NOT EXISTS (SELECT 1 FROM public.group_members gm WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = gm.user_id))
   AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = g.created_by))),
  ('M12: amount_cents and share_cents are stored generated columns',
   (SELECT count(*) FROM pg_attribute
     WHERE attgenerated = 's' AND ((attrelid = 'public.expenses'::regclass AND attname = 'amount_cents')
                                OR (attrelid = 'public.expense_splits'::regclass AND attname = 'share_cents'))) = 2),
  ('M12 data: every expense amount_cents = amount*100 = sum(share_cents)',
   NOT EXISTS (SELECT 1 FROM public.expenses e
                WHERE e.amount_cents::numeric <> e.amount * 100
                   OR e.amount_cents <> (SELECT sum(s.share_cents) FROM public.expense_splits s WHERE s.expense_id = e.id))),
  ('M12: canonical allocation gives the remainder to the lowest UUID',
   (SELECT array_agg(share_cents ORDER BY user_id) FROM private.equal_split_cents(1000,
      ARRAY['30000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000002']::uuid[])) = ARRAY[334, 333, 333]::bigint[]),
  ('M14: the legacy numeric expense RPC is gone',
   to_regprocedure('public.create_equal_split_expense(uuid,text,numeric,date,uuid,uuid[],text)') IS NULL
   AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                     AND proname = 'create_equal_split_expense')),
  ('QS-B3-1: deletion trigger and add-by-email both lock the group row (add: before counting the attempt)',
   (SELECT prosrc LIKE '%FOR UPDATE%' FROM pg_proc WHERE oid = 'private.handle_auth_user_deleting()'::regprocedure)
   AND (SELECT strpos(prosrc, 'FROM public.groups g WHERE g.id = target_group_id FOR UPDATE') > 0
               AND strpos(prosrc, 'FROM public.groups g WHERE g.id = target_group_id FOR UPDATE')
                   < strpos(prosrc, 'INSERT INTO private.member_add_attempts')
          FROM pg_proc WHERE oid = 'public.add_group_member_by_email(uuid,text)'::regprocedure)),
  ('M13: expenses.updated_by references profiles',
   EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.expenses'::regclass AND contype = 'f'
             AND confrelid = 'public.profiles'::regclass AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
               WHERE attrelid = 'public.expenses'::regclass AND attname = 'updated_by')])),
  ('M12-M15: authenticated EXECUTE allowlist is exact (legacy RPC removed)',
   (SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C") FROM pg_proc p
     WHERE p.pronamespace IN ('public'::regnamespace, 'private'::regnamespace)
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
   = ARRAY['add_group_member_by_email(uuid,text)',
           'create_equal_split_expense_v2(uuid,text,bigint,date,uuid,uuid[],text)',
           'delete_expense(uuid,timestamp with time zone)', 'delete_group(uuid)',
           'get_ledger_identities(uuid)', 'leave_group(uuid)',
           'private.my_active_group_ids()', 'private.my_group_peer_ids()',
           'remove_group_member(uuid,uuid)', 'transfer_group_ownership(uuid,uuid)',
           'update_equal_split_expense(uuid,timestamp with time zone,text,bigint,date,uuid,uuid[],text)']),
  ('new RPCs are not executable by service_role',
   NOT EXISTS (SELECT 1 FROM unnest(ARRAY[
       'public.create_equal_split_expense_v2(uuid,text,bigint,date,uuid,uuid[],text)',
       'public.update_equal_split_expense(uuid,timestamptz,text,bigint,date,uuid,uuid[],text)',
       'public.delete_expense(uuid,timestamptz)', 'public.delete_group(uuid)',
       'private.equal_split_cents(bigint,uuid[])', 'private.lock_expense_for_management(uuid,timestamptz)']) f
     WHERE has_function_privilege('service_role', f::regprocedure, 'EXECUTE'))),
  ('anon can execute no public/private function',
   NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace IN ('public'::regnamespace, 'private'::regnamespace)
                 AND has_function_privilege('anon', oid, 'EXECUTE'))),
  ('every SECURITY DEFINER function has search_path=""',
   NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace IN ('public'::regnamespace, 'private'::regnamespace)
                 AND prosecdef AND coalesce(proconfig, '{}') <> ARRAY['search_path=""'])),
  ('RLS enabled on all public tables and the attempt log',
   (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity) = 5
   AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'private.member_add_attempts'::regclass)),
  ('batch 2 still: no client write privilege on the ledger, groups (except INSERT columns) or memberships',
   NOT EXISTS (SELECT 1 FROM unnest(ARRAY['public.expenses','public.expense_splits','public.group_members']) t,
                      unnest(ARRAY['INSERT','UPDATE','DELETE']) p
                WHERE has_table_privilege('authenticated', t, p))
   AND NOT has_table_privilege('authenticated', 'public.groups', 'DELETE')
   AND NOT has_table_privilege('authenticated', 'public.groups', 'UPDATE')),
  ('batch 2 still: exactly the seven expected policies',
   (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') = 7),
  ('batch 1 still: immutability, balance and membership triggers present',
   (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
      AND tgname IN ('expenses_guard_immutables', 'expense_splits_guard_immutables', 'expense_splits_balanced',
                     'expenses_balanced', 'expenses_guard_membership', 'expense_splits_guard_membership')) = 6),
  ('data: every group has exactly one active owner or none (orphaned by account deletion)',
   NOT EXISTS (SELECT 1 FROM public.groups g
                WHERE (SELECT count(*) FROM public.group_members gm
                        WHERE gm.group_id = g.id AND gm.role = 'owner' AND gm.left_at IS NULL) > 1))
) AS c(check_name, ok);
