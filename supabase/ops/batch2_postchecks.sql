-- Production batch 2 (M6-M10) read-only post-apply verification.
-- Catalog-only (no row contents) plus one aggregate data invariant.
-- Every row must report ok = true.

SELECT check_name, ok FROM (VALUES
  ('history: M0-M10 recorded, nothing else',
   (SELECT array_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations)
     = ARRAY['20260926000000','20260926100000','20260926110000','20260926120000','20260926130000',
             '20260926140000','20260926150000','20260926160000','20260926170000','20260926180000',
             '20260926190000']),
  ('RLS enabled on all public tables and the attempt log',
   (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity) = 5
   AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'private.member_add_attempts'::regclass)),
  ('M6: anon holds no privilege on any public table',
   NOT EXISTS (SELECT 1 FROM pg_class c
                 CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND has_table_privilege('anon', c.oid, p))),
  ('M6: authenticated holds no TRUNCATE/REFERENCES/TRIGGER',
   NOT EXISTS (SELECT 1 FROM pg_class c
                 CROSS JOIN unnest(ARRAY['TRUNCATE','REFERENCES','TRIGGER']) p
                WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND has_table_privilege('authenticated', c.oid, p))),
  ('M6: groups writable only via INSERT(name, description, created_by)',
   NOT has_table_privilege('authenticated', 'public.groups', 'INSERT')
   AND NOT has_table_privilege('authenticated', 'public.groups', 'UPDATE')
   AND NOT has_table_privilege('authenticated', 'public.groups', 'DELETE')
   AND has_column_privilege('authenticated', 'public.groups', 'name', 'INSERT')
   AND NOT has_column_privilege('authenticated', 'public.groups', 'created_at', 'INSERT')),
  ('M6: profiles updatable only in full_name/avatar_url, never inserted/deleted',
   NOT has_table_privilege('authenticated', 'public.profiles', 'INSERT')
   AND NOT has_table_privilege('authenticated', 'public.profiles', 'DELETE')
   AND has_column_privilege('authenticated', 'public.profiles', 'full_name', 'UPDATE')
   AND NOT has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE')),
  ('M6/M10: no client write privilege on group_members',
   NOT EXISTS (SELECT 1 FROM unnest(ARRAY['INSERT','UPDATE','DELETE']) p
                WHERE has_table_privilege('authenticated', 'public.group_members', p))),
  ('M3 still: no client write privilege on the ledger',
   NOT EXISTS (SELECT 1 FROM unnest(ARRAY['public.expenses','public.expense_splits']) t,
                      unnest(ARRAY['INSERT','UPDATE','DELETE']) p
                WHERE has_table_privilege('authenticated', t, p))),
  ('M6: default privileges grant nothing to client roles or PUBLIC',
   NOT EXISTS (SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a
                WHERE d.defaclrole = 'postgres'::regrole
                  AND (d.defaclnamespace = 'public'::regnamespace OR d.defaclnamespace = 0)
                  AND a.grantee IN (0, 'anon'::regrole, 'authenticated'::regrole))),
  ('M7: membership history columns and constraints present and validated',
   (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.group_members'::regclass AND convalidated
      AND conname IN ('group_members_left_reason_check', 'group_members_left_consistency',
                      'group_members_removed_by_consistency', 'group_members_owner_active')) = 4),
  ('M7: one-active-owner unique index present',
   to_regclass('public.group_members_one_active_owner') IS NOT NULL),
  ('M7 data: every group has exactly one active owner',
   NOT EXISTS (SELECT 1 FROM public.groups g
                WHERE (SELECT count(*) FROM public.group_members gm
                        WHERE gm.group_id = g.id AND gm.role = 'owner' AND gm.left_at IS NULL) <> 1)),
  ('M7: groups identity guard trigger present',
   EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'groups_guard_immutables' AND NOT tgisinternal)),
  ('M8: exposed membership helpers removed',
   to_regprocedure('public.split_chat_is_group_member(uuid,uuid)') IS NULL
   AND to_regprocedure('public.is_group_member(uuid)') IS NULL
   AND to_regprocedure('public.is_group_owner(uuid)') IS NULL
   AND to_regprocedure('public.shares_group_with(uuid)') IS NULL),
  ('M8-M10: authenticated EXECUTE allowlist is exact',
   (SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) FROM pg_proc p
     WHERE p.pronamespace IN ('public'::regnamespace, 'private'::regnamespace)
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
   = ARRAY['add_group_member_by_email(uuid,text)',
           'create_equal_split_expense(uuid,text,numeric,date,uuid,uuid[],text)',
           'get_ledger_identities(uuid)', 'leave_group(uuid)',
           'private.my_active_group_ids()', 'private.my_group_peer_ids()',
           'remove_group_member(uuid,uuid)', 'transfer_group_ownership(uuid,uuid)']),
  ('anon can execute no public/private function',
   NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace IN ('public'::regnamespace, 'private'::regnamespace)
                 AND has_function_privilege('anon', oid, 'EXECUTE'))),
  ('every SECURITY DEFINER function has search_path=""',
   NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace IN ('public'::regnamespace, 'private'::regnamespace)
                 AND prosecdef AND coalesce(proconfig, '{}') <> ARRAY['search_path=""'])),
  ('M8: private usable by authenticated only',
   has_schema_privilege('authenticated', 'private', 'USAGE') AND NOT has_schema_privilege('anon', 'private', 'USAGE')),
  ('M8-M10: exactly the seven expected policies',
   (SELECT array_agg(tablename || ':' || policyname ORDER BY tablename, policyname) FROM pg_policies WHERE schemaname = 'public')
   = ARRAY['expense_splits:Group members can view expense splits', 'expenses:Group members can view expenses',
           'group_members:Members can view group members', 'groups:Members can view their groups',
           'groups:Users can create groups', 'profiles:Users can update their own profile',
           'profiles:Users can view relevant profiles']),
  ('M8: triggers bound to private functions',
   (SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND p.pronamespace = 'private'::regnamespace
       AND t.tgname IN ('on_auth_user_created', 'on_group_created', 'set_groups_updated_at',
                        'set_profiles_updated_at', 'expenses_set_updated_at')) = 5),
  ('batch 1 still: immutability, balance and membership triggers present',
   (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
      AND tgname IN ('expenses_guard_immutables', 'expense_splits_guard_immutables', 'expense_splits_balanced',
                     'expenses_balanced', 'expenses_guard_membership', 'expense_splits_guard_membership')) = 6),
  ('batch 1 still: split_type equal and groups.created_by RESTRICT',
   (SELECT pg_get_constraintdef(oid) = 'CHECK ((split_type = ''equal''::text))' FROM pg_constraint WHERE conname = 'expenses_split_type_check')
   AND (SELECT confdeltype = 'r' FROM pg_constraint WHERE conname = 'groups_created_by_fkey'))
) AS c(check_name, ok);
