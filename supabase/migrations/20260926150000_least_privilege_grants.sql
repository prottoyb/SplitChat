SET LOCAL lock_timeout = '5s';

-- M6: least-privilege table grants and default privileges (QS-5, QS-9,
-- AR-4). Design: docs/phase1/design.md §A6, §B M6 · ADR-0003.
--
-- Client roles keep only what the frontend uses:
--   anon           no table privileges (USAGE on public only)
--   authenticated  SELECT on all five tables (RLS still applies);
--                  INSERT(name, description, created_by) on groups;
--                  UPDATE(full_name, avatar_url) on own profile (RLS);
--                  DELETE on group_members until M10 (leave/remove).
-- Nobody but service_role keeps TRUNCATE, REFERENCES or TRIGGER.
-- Owner INSERT into group_members and direct group UPDATE/DELETE are
-- removed (membership changes move to RPCs in M9).
-- Default privileges stop auto-granting new postgres-created objects to
-- client roles, so every future object needs an explicit grant.

REVOKE ALL ON public.profiles FROM anon;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.groups, public.profiles FROM authenticated;
REVOKE INSERT, UPDATE, TRUNCATE, REFERENCES, TRIGGER
  ON public.group_members FROM authenticated;

GRANT INSERT (name, description, created_by) ON public.groups TO authenticated;
GRANT UPDATE (full_name, avatar_url) ON public.profiles TO authenticated;

DROP POLICY "Owners can add group members" ON public.group_members;
DROP POLICY "Owners can update groups" ON public.groups;
DROP POLICY "Owners can delete groups" ON public.groups;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
