-- Read-only security audit of the client-facing database surface (Phase 8).
-- Every query returns the OFFENDING rows: a clean database returns 0 rows for
-- A1-A9. Safe on any environment (catalog reads only); run inside a read-only
-- transaction (scripts/rehearsal/dev.mjs readonly, or scripts/ops/prod.mjs).

\echo 'A1 public/private tables without RLS'
SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;

\echo 'A2 table privileges held by anon or PUBLIC in public (expected only: anon SELECT on the two published tables, M23)'
SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND grantee IN ('anon', 'PUBLIC')
   AND NOT (grantee = 'anon' AND privilege_type = 'SELECT' AND table_name IN ('group_messages', 'expense_candidates'));

\echo 'A3 client write privileges on public tables (only the column-level INSERT on groups is expected; see A3b)'
SELECT table_name, privilege_type FROM information_schema.role_table_grants
 WHERE table_schema = 'public' AND grantee = 'authenticated' AND privilege_type <> 'SELECT';
\echo 'A3b column-level client writes other than: INSERT (name, description, created_by) on groups; UPDATE (full_name, avatar_url) on profiles (own row, A10)'
SELECT table_name, column_name, grantee, privilege_type FROM information_schema.column_privileges
 WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT'
   AND NOT (table_name = 'groups' AND grantee = 'authenticated' AND privilege_type = 'INSERT'
            AND column_name IN ('name', 'description', 'created_by'))
   AND NOT (table_name = 'profiles' AND grantee = 'authenticated' AND privilege_type = 'UPDATE'
            AND column_name IN ('full_name', 'avatar_url'));

\echo 'A4 functions executable by anon or PUBLIC in public/private'
SELECT n.nspname, p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('public', 'private')
   AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'));

\echo 'A5 SECURITY DEFINER functions without an empty search_path'
SELECT p.oid::regprocedure, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('public', 'private') AND p.prosecdef
   AND NOT coalesce(p.proconfig @> ARRAY['search_path=""'] OR p.proconfig @> ARRAY['search_path='], false);

\echo 'A6 private functions executable by authenticated (expected: exactly the RLS helpers my_active_group_ids, my_group_peer_ids)'
SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'private' AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
   AND p.proname NOT IN ('my_active_group_ids', 'my_group_peer_ids');

\echo 'A7 private schema exposed to anon'
SELECT 'private' WHERE has_schema_privilege('anon', 'private', 'USAGE');

\echo 'A8 Realtime publication: tables other than group_messages and expense_candidates, or FOR ALL TABLES'
SELECT pubname, 'FOR ALL TABLES' FROM pg_publication WHERE pubname = 'supabase_realtime' AND puballtables
UNION ALL
SELECT pubname, schemaname || '.' || tablename FROM pg_publication_tables
 WHERE pubname = 'supabase_realtime' AND (schemaname, tablename) NOT IN (('public', 'group_messages'), ('public', 'expense_candidates'));

\echo 'A9 policies granting anything other than SELECT to client roles on the Phase 3-7 tables'
SELECT tablename, policyname, cmd, roles FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('group_events', 'settlements', 'group_messages', 'expense_candidates')
   AND (cmd <> 'SELECT'
        OR NOT (roles <@ ARRAY['authenticated']::name[]
                -- M23: the RESTRICTIVE always-false anon policies deny, never grant.
                OR (roles = ARRAY['anon']::name[] AND permissive = 'RESTRICTIVE' AND qual = 'false')));

\echo 'A10 profile UPDATE not limited to the caller''s own row (expected: USING and WITH CHECK both auth.uid() = id)'
SELECT policyname, qual, with_check FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'profiles' AND cmd IN ('UPDATE', 'ALL')
   AND NOT (replace(qual, ' ', '') = '((SELECTauth.uid()ASuid)=id)'
            AND replace(coalesce(with_check, ''), ' ', '') = '((SELECTauth.uid()ASuid)=id)');

\echo 'A11 published tables without a RESTRICTIVE always-false SELECT policy for anon (M23)'
SELECT pt.tablename FROM pg_publication_tables pt
 WHERE pt.pubname = 'supabase_realtime' AND pt.schemaname = 'public'
   AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = pt.tablename
                    AND p.permissive = 'RESTRICTIVE' AND p.roles = ARRAY['anon']::name[] AND p.qual = 'false');

\echo 'I1 (information) Realtime publication contents'
SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime' ORDER BY 1, 2;
