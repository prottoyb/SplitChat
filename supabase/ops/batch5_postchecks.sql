-- Production batch 5 (M24-M25, Phase 9) read-only post-apply verification.
-- Catalog checks plus aggregate data invariants; no row contents.
-- Every row must report ok = true (scripts/ops/prod.mjs verify). The exact
-- schema comparison with batch5_expected_schema.sql runs separately; these
-- checks are named, readable defence in depth on top of it.
-- Pinned to PostgreSQL 17 output: the M25 check compares
-- pg_get_constraintdef() exactly and the handle_new_user check matches
-- fragments of its source (LIKE, where "_" matches any character, so it can
-- only over-match). A major-version upgrade may require re-pinning the text;
-- both fail closed.

SELECT check_name, ok FROM (VALUES
  ('history: the 25 batch 4 versions plus M24 and M25, nothing else (27)',
   (SELECT array_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations)
     = ARRAY['20260926000000','20260926100000','20260926110000','20260926120000','20260926130000',
             '20260926140000','20260926150000','20260926160000','20260926170000','20260926180000',
             '20260926190000','20260927100000','20260927110000','20260927120000','20260927130000',
             '20260927135000','20260927140000','20260928100000','20260928110000','20260928120000',
             '20260929100000','20260929110000','20260930100000','20260930110000','20260930120000',
             '20261001100000','20261001110000']),
  ('M24: update_group_details(uuid,text,text,timestamptz) is the only function of that name, returns timestamptz, plpgsql SECURITY DEFINER with an empty search_path',
   (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('public', 'private') AND p.proname = 'update_group_details') = 1
   AND EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
                WHERE p.oid = to_regprocedure('public.update_group_details(uuid,text,text,timestamptz)')
                  AND p.prorettype = 'timestamptz'::regtype AND NOT p.proretset
                  AND l.lanname = 'plpgsql' AND p.prosecdef
                  AND coalesce(p.proconfig @> ARRAY['search_path=""'] OR p.proconfig @> ARRAY['search_path='], false))),
  ('M24: update_group_details is executable by authenticated only (not anon, PUBLIC or service_role)',
   has_function_privilege('authenticated', 'public.update_group_details(uuid,text,text,timestamptz)', 'EXECUTE')
   AND NOT has_function_privilege('anon', 'public.update_group_details(uuid,text,text,timestamptz)', 'EXECUTE')
   AND NOT has_function_privilege('service_role', 'public.update_group_details(uuid,text,text,timestamptz)', 'EXECUTE')
   AND (SELECT array_agg(g ORDER BY g) FROM (
          SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS g
            FROM pg_proc p, aclexplode(p.proacl) a
           WHERE p.oid = to_regprocedure('public.update_group_details(uuid,text,text,timestamptz)')
             AND a.privilege_type = 'EXECUTE') x) = ARRAY['authenticated', 'postgres']),
  ('M24: clients still have no direct UPDATE path on public.groups (grants or policies)',
   NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                WHERE table_schema = 'public' AND table_name = 'groups' AND privilege_type = 'UPDATE'
                  AND grantee IN ('anon', 'authenticated', 'PUBLIC'))
   AND NOT EXISTS (SELECT 1 FROM information_schema.column_privileges
                    WHERE table_schema = 'public' AND table_name = 'groups' AND privilege_type = 'UPDATE'
                      AND grantee IN ('anon', 'authenticated', 'PUBLIC'))
   AND NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = 'groups' AND cmd IN ('UPDATE', 'ALL'))
   -- effective privileges, whoever granted them
   AND NOT has_any_column_privilege('anon', 'public.groups', 'UPDATE')
   AND NOT has_any_column_privilege('authenticated', 'public.groups', 'UPDATE')
   AND NOT has_any_column_privilege('public', 'public.groups', 'UPDATE')),
  ('M24: group_events_kind_check is validated and allows group_updated; clients hold no write privilege on group_events',
   EXISTS (SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.group_events'::regclass AND conname = 'group_events_kind_check'
              AND contype = 'c' AND convalidated
              AND pg_get_constraintdef(oid) LIKE '%''group_updated''::text%')
   AND to_regprocedure('private.record_group_event(uuid,uuid,text,uuid,uuid,uuid[],jsonb)') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                    WHERE table_schema = 'public' AND table_name = 'group_events'
                      AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT')),
  ('M25: profiles_full_name_check is a CHECK added NOT VALID with the reviewed expression (tombstones exempt)',
   EXISTS (SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.profiles'::regclass AND conname = 'profiles_full_name_check'
              AND contype = 'c' AND NOT convalidated
              AND pg_get_constraintdef(oid) =
                'CHECK (((deleted_at IS NOT NULL) OR ((full_name = btrim(full_name)) AND ((char_length(full_name) >= 1) AND (char_length(full_name) <= 80)) AND (lower(regexp_replace(full_name, ''\s+''::text, '' ''::text, ''g''::text)) <> ''deleted user''::text)))) NOT VALID')),
  ('M25: no live profile breaks the display-name rule',
   NOT EXISTS (SELECT 1 FROM public.profiles
                WHERE deleted_at IS NULL
                  AND NOT (full_name = btrim(full_name)
                           AND char_length(full_name) BETWEEN 1 AND 80
                           AND lower(regexp_replace(full_name, '\s+', ' ', 'g')) <> 'deleted user'))),
  ('M25: handle_new_user trims, caps at 80 and replaces blank or reserved sign-up names; still SECURITY DEFINER with an empty search_path',
   EXISTS (SELECT 1 FROM pg_proc p
            WHERE p.oid = to_regprocedure('private.handle_new_user()')
              AND p.prosecdef
              AND coalesce(p.proconfig @> ARRAY['search_path=""'] OR p.proconfig @> ARRAY['search_path='], false)
              AND p.prosrc LIKE '%btrim(left(btrim(coalesce(NEW.raw_user_meta_data ->> ''full_name'', '''')), 80))%'
              AND p.prosrc LIKE '%= ''deleted user''%'
              AND p.prosrc LIKE '%split_part(coalesce(NEW.email, ''''), ''@'', 1)%'
              AND p.prosrc LIKE '%''SplitChat member''%')),
  ('M25: on_auth_user_created is enabled on auth.users and runs private.handle_new_user',
   EXISTS (SELECT 1 FROM pg_trigger
            WHERE tgrelid = 'auth.users'::regclass AND tgname = 'on_auth_user_created'
              AND tgenabled <> 'D' AND tgfoid = to_regprocedure('private.handle_new_user()'))),
  ('profiles grants and RLS as reviewed: RLS on; anon nothing; authenticated SELECT plus UPDATE of full_name and avatar_url only; the two own/peer policies',
   (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.profiles'::regclass)
   AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                    WHERE table_schema = 'public' AND table_name = 'profiles' AND grantee IN ('anon', 'PUBLIC'))
   AND NOT EXISTS (SELECT 1 FROM information_schema.column_privileges
                    WHERE table_schema = 'public' AND table_name = 'profiles' AND grantee IN ('anon', 'PUBLIC'))
   AND NOT has_any_column_privilege('anon', 'public.profiles', 'SELECT, INSERT, UPDATE, REFERENCES')
   AND NOT has_table_privilege('authenticated', 'public.profiles', 'INSERT, DELETE, TRUNCATE')
   AND (SELECT array_agg(privilege_type::text ORDER BY privilege_type) FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = 'profiles' AND grantee = 'authenticated'
           AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')) = ARRAY['SELECT']
   AND (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.column_privileges
         WHERE table_schema = 'public' AND table_name = 'profiles' AND grantee = 'authenticated'
           AND privilege_type = 'UPDATE') = ARRAY['avatar_url', 'full_name']
   AND (SELECT array_agg(policyname::text ORDER BY policyname) FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'profiles')
       = ARRAY['Users can update their own profile', 'Users can view relevant profiles']),
  ('RLS enabled on every public table',
   NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relrowsecurity)),
  ('no public/private function executable by anon or PUBLIC',
   NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname IN ('public', 'private')
                  AND (has_function_privilege('anon', p.oid, 'EXECUTE')
                       OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                   WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')))),
  ('every SECURITY DEFINER function has an empty search_path',
   NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname IN ('public', 'private') AND p.prosecdef
                  AND NOT coalesce(p.proconfig @> ARRAY['search_path=""'] OR p.proconfig @> ARRAY['search_path='], false))),
  ('anon reads only the two published tables; Realtime publishes exactly group_messages and expense_candidates (batch 4 state kept)',
   (SELECT array_agg(table_name::text ORDER BY table_name) FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND grantee IN ('anon', 'PUBLIC'))
     = ARRAY['expense_candidates', 'group_messages']
   AND NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime' AND puballtables)
   AND (SELECT array_agg(tablename::text ORDER BY tablename) FROM pg_publication_tables WHERE pubname = 'supabase_realtime')
       = ARRAY['expense_candidates', 'group_messages']),
  ('ledger balanced: every expense has splits summing to its amount',
   NOT EXISTS (SELECT 1 FROM public.expenses e
                WHERE e.amount <> (SELECT coalesce(sum(s.share_amount), 0) FROM public.expense_splits s WHERE s.expense_id = e.id)))
) AS checks(check_name, ok);
