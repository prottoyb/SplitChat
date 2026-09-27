SHOW transaction_read_only;
SELECT current_setting('server_version') AS server_version, current_user, session_user;
SELECT n.nspname AS schema, pg_get_userbyid(n.nspowner) AS owner,
       (SELECT count(*) FROM pg_class c WHERE c.relnamespace=n.oid AND c.relkind IN ('r','p')) AS tables,
       (SELECT count(*) FROM pg_proc p WHERE p.pronamespace=n.oid) AS functions
FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' ORDER BY 1;
SELECT extname, extversion, extnamespace::regnamespace FROM pg_extension ORDER BY 1;
