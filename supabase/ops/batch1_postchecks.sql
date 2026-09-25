-- Production batch 1 (M0 repair + M1-M5) read-only post-apply verification.
-- Catalog-only (no row contents). Every row must report ok = true.
-- Run under the read-only transaction guard, as for the pre-checks.

SELECT check_name, ok FROM (VALUES
  ('history: M0-M5 recorded, nothing else',
   (SELECT array_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations)
     = ARRAY['20260926000000','20260926100000','20260926110000','20260926120000','20260926130000','20260926140000']),
  ('RLS enabled on all 5 public tables',
   (SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity) = 5),
  ('M1: expense/split immutability triggers present',
   (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
      AND tgname IN ('expenses_guard_immutables', 'expense_splits_guard_immutables')) = 2),
  ('M2: anon cannot execute any public/private function',
   NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace IN ('public'::regnamespace, 'private'::regnamespace)
                 AND has_function_privilege('anon', oid, 'EXECUTE'))),
  ('M2: every SECURITY DEFINER function has search_path=""',
   NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace IN ('public'::regnamespace, 'private'::regnamespace)
                 AND prosecdef AND coalesce(proconfig, '{}') <> ARRAY['search_path=""'])),
  ('M2: clients cannot execute trigger functions',
   NOT has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE')
   AND NOT has_function_privilege('authenticated', 'public.set_updated_at()', 'EXECUTE')),
  ('M2: authenticated keeps the expense RPC',
   has_function_privilege('authenticated', 'public.create_equal_split_expense(uuid,text,numeric,date,uuid,uuid[],text)', 'EXECUTE')),
  ('M3: no client write/truncate privilege on expenses or expense_splits',
   NOT EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['public.expenses','public.expense_splits']) t,
                      unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                WHERE has_table_privilege(r, t, p))),
  ('M3: anon cannot read the ledger',
   NOT has_table_privilege('anon', 'public.expenses', 'SELECT') AND NOT has_table_privilege('anon', 'public.expense_splits', 'SELECT')),
  ('M3: ledger tables have only SELECT policies',
   NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename IN ('expenses', 'expense_splits') AND cmd <> 'SELECT')),
  ('policy count is 11',
   (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') = 11),
  ('M4: deferred balance constraint triggers present',
   (SELECT count(*) FROM pg_trigger WHERE tgname IN ('expense_splits_balanced', 'expenses_balanced')
      AND tgdeferrable AND tginitdeferred) = 2),
  ('M4: membership guard triggers present',
   (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
      AND tgname IN ('expenses_guard_membership', 'expense_splits_guard_membership')) = 2),
  ('M4: split_type restricted to equal and validated',
   (SELECT convalidated AND pg_get_constraintdef(oid) = 'CHECK ((split_type = ''equal''::text))'
      FROM pg_constraint WHERE conname = 'expenses_split_type_check')),
  ('M5: groups.created_by FK is ON DELETE RESTRICT and validated',
   (SELECT convalidated AND confdeltype = 'r' FROM pg_constraint WHERE conname = 'groups_created_by_fkey')),
  ('private schema not usable by client roles',
   NOT has_schema_privilege('anon', 'private', 'USAGE') AND NOT has_schema_privilege('authenticated', 'private', 'USAGE')),
  ('profile trigger on auth.users still enabled',
   EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created'
             AND tgrelid = 'auth.users'::regclass AND tgenabled = 'O'))
) AS c(check_name, ok);
