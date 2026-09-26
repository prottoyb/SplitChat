-- Rollback of M11. PARTIAL and recovery-only; M11 is classified FIX-FORWARD.
--  * postgres may not DROP a trigger on the platform-owned auth.users, so the
--    on_auth_user_deleting trigger remains and its function is neutralised
--    (RETURN OLD). Re-applying M11 afterwards needs a new forward migration.
--  * Once any account has been deleted, tombstoned profiles have no auth
--    user: re-validating profiles_id_fkey fails and this rollback aborts
--    (by design; nothing is changed). Dropping deleted_at would discard
--    tombstone timestamps.
-- rollback-residual: handle_auth_user_deleting
-- rollback-no-reup
CREATE OR REPLACE FUNCTION private.handle_auth_user_deleting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN OLD;  -- neutralised by the M11 rollback
END
$$;

DROP FUNCTION private.admin_release_ownership(uuid);

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id)
  REFERENCES auth.users(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_id_fkey;

ALTER TABLE public.expenses DROP CONSTRAINT expenses_group_id_fkey;
ALTER TABLE public.expenses
  ADD CONSTRAINT expenses_group_id_fkey FOREIGN KEY (group_id)
  REFERENCES public.groups(id) ON DELETE CASCADE;

ALTER TABLE public.groups DROP CONSTRAINT groups_created_by_fkey;
ALTER TABLE public.groups
  ADD CONSTRAINT groups_created_by_fkey FOREIGN KEY (created_by)
  REFERENCES auth.users(id) ON DELETE RESTRICT;

ALTER TABLE public.group_members DROP CONSTRAINT group_members_user_id_fkey;
ALTER TABLE public.group_members
  ADD CONSTRAINT group_members_user_id_fkey FOREIGN KEY (user_id)
  REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.profiles DROP COLUMN deleted_at;
