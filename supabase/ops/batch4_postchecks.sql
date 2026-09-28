-- Production batch 4 (M16-M23) read-only post-apply verification.
-- Catalog checks plus aggregate data invariants; no row contents.
-- Every row must report ok = true (scripts/ops/prod.mjs verify).

SELECT check_name, ok FROM (VALUES
  ('history: M0-M15, the owner-deletion fix and M16-M23, nothing else',
   (SELECT array_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations)
     = ARRAY['20260926000000','20260926100000','20260926110000','20260926120000','20260926130000',
             '20260926140000','20260926150000','20260926160000','20260926170000','20260926180000',
             '20260926190000','20260927100000','20260927110000','20260927120000','20260927130000',
             '20260927135000','20260927140000','20260928100000','20260928110000','20260928120000',
             '20260929100000','20260929110000','20260930100000','20260930110000','20260930120000']),
  ('RLS enabled on every public table',
   NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relrowsecurity)),
  ('M16-M19 tables present',
   (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
      AND relname IN ('group_events', 'settlements', 'group_messages', 'expense_candidates')) = 4),
  ('clients hold no write privilege on the M16-M19 tables',
   NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
                  AND privilege_type <> 'SELECT'
                  AND table_name IN ('group_events', 'settlements', 'group_messages', 'expense_candidates'))),
  ('anon reads only the two published tables, and RESTRICTIVE policies deny it every row (M23)',
   (SELECT array_agg(table_name::text ORDER BY table_name) FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND grantee IN ('anon', 'PUBLIC'))
     = ARRAY['expense_candidates', 'group_messages']
   AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND permissive = 'RESTRICTIVE'
         AND roles = ARRAY['anon']::name[] AND qual = 'false') = 2),
  ('Realtime publishes exactly group_messages and expense_candidates (not FOR ALL TABLES)',
   NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime' AND puballtables)
   AND (SELECT array_agg(tablename::text ORDER BY tablename) FROM pg_publication_tables WHERE pubname = 'supabase_realtime')
       = ARRAY['expense_candidates', 'group_messages']),
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
  ('the expense core is private and v2 is callable by members only',
   NOT has_function_privilege('authenticated', 'private.create_equal_split_expense_core(uuid,uuid,text,bigint,date,uuid,uuid[],text,jsonb)', 'EXECUTE')
   AND has_function_privilege('authenticated', 'public.create_equal_split_expense_v2(uuid,text,bigint,date,uuid,uuid[],text)', 'EXECUTE')),
  ('M22 index set',
   to_regclass('public.expenses_group_date_idx') IS NOT NULL
   AND to_regclass('public.expense_splits_expense_id_idx') IS NULL
   AND to_regclass('public.expenses_group_id_idx') IS NULL),
  ('M16 backfill: every group has exactly one group_created event',
   NOT EXISTS (SELECT 1 FROM public.groups g
                WHERE (SELECT count(*) FROM public.group_events e
                        WHERE e.group_id = g.id AND e.kind = 'group_created') <> 1)),
  ('M16 backfill: every non-founding membership has a member_added event',
   NOT EXISTS (SELECT 1 FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id
                WHERE gm.user_id <> g.created_by
                  AND NOT EXISTS (SELECT 1 FROM public.group_events e
                                   WHERE e.group_id = gm.group_id AND e.kind = 'member_added' AND e.subject_user_id = gm.user_id))),
  ('ledger balanced: every expense has splits summing to its amount',
   NOT EXISTS (SELECT 1 FROM public.expenses e
                WHERE e.amount <> (SELECT coalesce(sum(s.share_amount), 0) FROM public.expense_splits s WHERE s.expense_id = e.id)))
) AS checks(check_name, ok);
