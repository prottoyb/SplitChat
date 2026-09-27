-- Supabase compatibility shim, part 1: cluster-wide roles.
-- TEST-ONLY. Never a migration. Run as the disposable cluster's superuser
-- (cluster_admin) against the maintenance database. Mirrors the production
-- role attributes captured in supabase/baseline/catalog_inventory.txt §11.

CREATE ROLE postgres LOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS INHERIT;
CREATE ROLE anon NOLOGIN NOBYPASSRLS INHERIT;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS INHERIT;
CREATE ROLE service_role NOLOGIN BYPASSRLS INHERIT;
CREATE ROLE authenticator LOGIN NOINHERIT;
GRANT anon, authenticated, service_role TO authenticator;

-- Platform roles. supabase_admin is a superuser on Supabase; here it only
-- needs to exist as the owner of its default-privilege entries.
CREATE ROLE supabase_admin NOLOGIN;
CREATE ROLE supabase_auth_admin NOLOGIN NOINHERIT CREATEROLE;

ALTER ROLE anon SET statement_timeout = '3s';
ALTER ROLE authenticated SET statement_timeout = '8s';
