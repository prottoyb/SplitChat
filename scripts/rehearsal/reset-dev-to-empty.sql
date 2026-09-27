-- SplitChat-Dev ONLY: return the rehearsal database to the empty state a new
-- Supabase project has before M0 (operator-approved dev reset, 2026-09-27),
-- so production's path M0 -> batch 1 -> batch 2 -> batch 3 can be rehearsed
-- from scratch. Run only as
--   node scripts/rehearsal/dev.mjs file scripts/rehearsal/reset-dev-to-empty.sql
-- (ref guard + sentinel check before connecting; one transaction: any
-- failure changes nothing). The first statement re-checks the sentinel
-- inside the database and aborts anywhere else.
--
-- Removes: the SplitChat schema objects in public, the private schema, the
-- CLI migration history, both SplitChat triggers on auth.users, and every
-- auth user (all synthetic rehearsal accounts). Restores the platform's
-- default privileges for postgres in public (M6 had revoked them), as in
-- supabase/baseline/public_schema.sql. Keeps: the sentinel schema, the public
-- schema itself and its platform ACLs, and everything the platform owns.
--
-- Note: M11's trigger on auth.users cannot be dropped directly by postgres;
-- here it goes as a dependent object of its function (DROP ... CASCADE).
-- This is a dev reset technique, not a reviewed production rollback.

DO $$
BEGIN
  IF coalesce(obj_description(to_regnamespace('splitchat_rehearsal_sentinel'), 'pg_namespace'), '')
     <> 'SplitChat-Dev opviwtyfssxoheigflxw' THEN
    RAISE EXCEPTION 'REFUSING: this database is not SplitChat-Dev';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS private.handle_auth_user_deleting() CASCADE;  -- and on_auth_user_deleting
DROP SCHEMA IF EXISTS private CASCADE;  -- and on_auth_user_created (bound to private.handle_new_user)
DROP TABLE IF EXISTS public.expense_splits, public.expenses, public.group_members,
  public.groups, public.profiles CASCADE;
DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace = 'public'::regnamespace LOOP
    EXECUTE format('DROP FUNCTION %s CASCADE', f);
  END LOOP;
END
$$;
DROP SCHEMA IF EXISTS supabase_migrations CASCADE;

DELETE FROM auth.users;  -- synthetic rehearsal accounts only

ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;

-- Post-conditions (abort, changing nothing, if any fails).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace)
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace)
     OR to_regnamespace('private') IS NOT NULL
     OR to_regnamespace('supabase_migrations') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal)
     OR EXISTS (SELECT 1 FROM auth.users) THEN
    RAISE EXCEPTION 'reset post-condition failed';
  END IF;
END
$$;
