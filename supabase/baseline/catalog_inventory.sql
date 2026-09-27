\echo '== 1. RLS status (all non-system schemas) =='
SELECT n.nspname AS schema, c.relname AS table, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
       c.reltuples::bigint AS est_rows, pg_get_userbyid(c.relowner) AS owner
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','storage','realtime','vault','graphql_public')
ORDER BY 1,2;

\echo '== 2. Policies outside public (storage/realtime/etc.) =='
SELECT schemaname, tablename, policyname, cmd, roles, permissive, qual, with_check
FROM pg_policies WHERE schemaname <> 'public' ORDER BY 1,2,3;

\echo '== 3. Policy summary public =='
SELECT tablename, cmd, count(*) AS n, array_agg(policyname ORDER BY policyname) AS names, array_agg(DISTINCT roles::text) AS roles, bool_and(permissive='PERMISSIVE') AS all_permissive
FROM pg_policies WHERE schemaname='public' GROUP BY 1,2 ORDER BY 1,2;

\echo '== 4. Non-internal triggers in all schemas (incl. auth.users) =='
SELECT n.nspname AS schema, c.relname AS table, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS def
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog','information_schema')
ORDER BY 1,2,3;

\echo '== 5. Event triggers =='
SELECT evtname, evtevent, evtowner::regrole, evtfoid::regproc, evtenabled FROM pg_event_trigger ORDER BY 1;

\echo '== 6. Public functions: security, config, volatility, ACL =='
SELECT p.oid::regprocedure AS function, p.prosecdef AS security_definer, p.provolatile AS vol, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
       p.prorettype::regtype AS returns, p.proacl
FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY 1::text;

\echo '== 7. EXECUTE privilege matrix on public functions =='
SELECT p.oid::regprocedure AS function,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
       has_function_privilege('public', p.oid, 'EXECUTE') AS public_role
FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY 1::text;

\echo '== 8. Table privilege matrix (public) =='
SELECT c.relname AS table, r.rolname AS role,
       string_agg(pr.priv, ',' ORDER BY pr.priv) FILTER (WHERE has_table_privilege(r.oid, c.oid, pr.priv)) AS privileges
FROM pg_class c
CROSS JOIN (SELECT oid, rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) r
CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) pr(priv)
WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m')
GROUP BY 1,2 ORDER BY 1,2;

\echo '== 9. Column-level grants in public =='
SELECT table_name, column_name, grantee, privilege_type FROM information_schema.column_privileges
WHERE table_schema='public' AND grantee IN ('anon','authenticated')
  AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants g WHERE g.table_schema='public' AND g.table_name=column_privileges.table_name AND g.grantee=column_privileges.grantee AND g.privilege_type=column_privileges.privilege_type)
ORDER BY 1,2,3;

\echo '== 10. Schema privileges =='
SELECT n.nspname, r.rolname,
       has_schema_privilege(r.oid, n.oid, 'USAGE') AS usage, has_schema_privilege(r.oid, n.oid, 'CREATE') AS create_priv
FROM pg_namespace n CROSS JOIN (SELECT oid, rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','public','service_role')
  UNION ALL SELECT 0, 'PUBLIC') r
WHERE n.nspname IN ('public','extensions','auth','storage') AND r.oid <> 0
ORDER BY 1,2;
SELECT nspname, nspacl FROM pg_namespace WHERE nspname IN ('public','extensions');

\echo '== 11. API roles attributes =='
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolinherit, rolconfig
FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','authenticator','postgres') ORDER BY 1;
SELECT r.rolname AS member, m.rolname AS member_of FROM pg_auth_members am JOIN pg_roles r ON r.oid=am.member JOIN pg_roles m ON m.oid=am.roleid
WHERE r.rolname IN ('anon','authenticated','authenticator') ORDER BY 1,2;

\echo '== 12. Views / matviews / sequences / types in public =='
SELECT c.relname, c.relkind, c.reloptions FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('v','m','S','f') ORDER BY 1;
SELECT t.typname, t.typtype FROM pg_type t WHERE t.typnamespace='public'::regnamespace AND t.typtype IN ('e','d','c') AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype=t.oid) ORDER BY 1;

\echo '== 13. Realtime publications =='
SELECT pubname, puballtables, pubinsert, pubupdate, pubdelete FROM pg_publication ORDER BY 1;
SELECT pubname, schemaname, tablename FROM pg_publication_tables ORDER BY 1,2,3;

\echo '== 14. Migration history presence =='
SELECT nspname FROM pg_namespace WHERE nspname IN ('supabase_migrations','supabase_functions','net','cron','pgsodium');
SELECT to_regclass('supabase_migrations.schema_migrations') AS migrations_table;

\echo '== 15. Constraints summary (public) =='
SELECT conrelid::regclass AS table, conname, contype, pg_get_constraintdef(oid) AS def
FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1::text, 3, 2;

\echo '== 16. Functions in other app-relevant schemas that reference public =='
SELECT p.oid::regprocedure, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('auth','storage','extensions','graphql_public') AND (CASE WHEN p.prokind='f' THEN pg_get_functiondef(p.oid) ~* 'public\.' ELSE false END)
ORDER BY 1::text;

\echo '== 17. PostgREST-relevant db settings =='
SELECT d.setrole::regrole, d.setdatabase, d.setconfig FROM pg_db_role_setting d
JOIN pg_roles r ON r.oid=d.setrole WHERE r.rolname IN ('authenticator','anon','authenticated') ORDER BY 1::text;
