SET LOCAL lock_timeout = '5s';

-- M11: account deletion preserves the historical ledger (QS-4 final, AR-3,
-- DS-2, DS-5, DS-11, DS-13). Design: docs/phase1/design.md §A5 ·
-- ADR-0005 · "Review resolutions".
--
--  - Profiles become the identity anchor and outlive auth accounts: the
--    profiles -> auth.users cascade is dropped; memberships and group
--    creators reference profiles (RESTRICT); expenses no longer cascade
--    from groups (RESTRICT).
--  - A BEFORE DELETE trigger on auth.users (GoTrue's delete path):
--      * refuses (owner_must_transfer) while the user is the active owner of
--        a group that has other active members - nothing changes;
--      * otherwise marks every active membership left
--        (left_reason = 'account_deleted'; a sole owner is demoted first,
--        so the group persists with no active members), and tombstones the
--        profile ('Deleted user', no avatar, deleted_at). Ledger rows are
--        never modified.
--  - private.admin_release_ownership(user) lets the OPERATOR (postgres only;
--    no client or service role) hand each of a user's owned multi-member
--    groups to its longest-standing active member, so an owner cannot make
--    their account undeletable (DS-2). Each use is a separately approved
--    production action.
--
-- CA-2: the auth.users trigger is proven on SplitChat-Dev through the real
-- Supabase Auth admin API (allowed and blocked deletions) before any
-- production proposal. postgres may CREATE a trigger on the platform-owned
-- auth.users but may not DROP it; see the rollback.
--
-- Production pre-checks: Q11 memberships whose user has no profile,
-- Q12 group creators / payers / expense creators with no profile, and
-- Q13 profiles with no auth user must all be 0 (the backfill below covers
-- any auth user that lacks a profile).

ALTER TABLE public.profiles ADD COLUMN deleted_at timestamptz;

-- Every auth user must have a profile before memberships reference profiles.
INSERT INTO public.profiles (id, full_name)
SELECT u.id,
       coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                split_part(coalesce(u.email, ''), '@', 1))
  FROM auth.users u
 WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id);

ALTER TABLE public.group_members DROP CONSTRAINT group_members_user_id_fkey;
ALTER TABLE public.group_members
  ADD CONSTRAINT group_members_user_id_fkey FOREIGN KEY (user_id)
  REFERENCES public.profiles(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.group_members VALIDATE CONSTRAINT group_members_user_id_fkey;

ALTER TABLE public.groups DROP CONSTRAINT groups_created_by_fkey;
ALTER TABLE public.groups
  ADD CONSTRAINT groups_created_by_fkey FOREIGN KEY (created_by)
  REFERENCES public.profiles(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.groups VALIDATE CONSTRAINT groups_created_by_fkey;

ALTER TABLE public.expenses DROP CONSTRAINT expenses_group_id_fkey;
ALTER TABLE public.expenses
  ADD CONSTRAINT expenses_group_id_fkey FOREIGN KEY (group_id)
  REFERENCES public.groups(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.expenses VALIDATE CONSTRAINT expenses_group_id_fkey;

ALTER TABLE public.profiles DROP CONSTRAINT profiles_id_fkey;

CREATE FUNCTION private.handle_auth_user_deleting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.group_members own
     WHERE own.user_id = OLD.id AND own.role = 'owner' AND own.left_at IS NULL
       AND EXISTS (SELECT 1 FROM public.group_members other
                    WHERE other.group_id = own.group_id AND other.user_id <> OLD.id
                      AND other.left_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'owner_must_transfer'
      USING ERRCODE = 'P0001',
            DETAIL = 'Transfer ownership of every shared group before deleting this account.';
  END IF;

  UPDATE public.group_members
     SET role = 'member', left_at = now(), left_reason = 'account_deleted', removed_by = NULL
   WHERE user_id = OLD.id AND left_at IS NULL;

  UPDATE public.profiles
     SET full_name = 'Deleted user', avatar_url = NULL, deleted_at = now()
   WHERE id = OLD.id;

  RETURN OLD;
END
$$;
REVOKE ALL ON FUNCTION private.handle_auth_user_deleting() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER on_auth_user_deleting
  BEFORE DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION private.handle_auth_user_deleting();

-- Operator-only ownership release (DS-2, DS-11, DS-13).
CREATE FUNCTION private.admin_release_ownership(p_user_id uuid)
RETURNS TABLE(group_id uuid, new_owner_id uuid)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_group uuid;
  v_successor uuid;
BEGIN
  FOR v_group IN
    SELECT gm.group_id FROM public.group_members gm
     WHERE gm.user_id = p_user_id AND gm.role = 'owner' AND gm.left_at IS NULL
     ORDER BY gm.group_id
  LOOP
    -- Lock the group's active memberships, then choose under the lock.
    PERFORM 1 FROM public.group_members gm
     WHERE gm.group_id = v_group AND gm.left_at IS NULL
     ORDER BY gm.user_id
     FOR UPDATE;

    SELECT gm.user_id INTO v_successor
      FROM public.group_members gm
      JOIN public.profiles p ON p.id = gm.user_id
     WHERE gm.group_id = v_group AND gm.user_id <> p_user_id
       AND gm.left_at IS NULL AND p.deleted_at IS NULL
     ORDER BY gm.joined_at, gm.user_id
     LIMIT 1;

    IF v_successor IS NULL THEN
      CONTINUE;  -- sole-member group: nothing to release
    END IF;

    UPDATE public.group_members SET role = 'member'
     WHERE group_members.group_id = v_group AND user_id = p_user_id;
    UPDATE public.group_members SET role = 'owner'
     WHERE group_members.group_id = v_group AND user_id = v_successor;

    group_id := v_group;
    new_owner_id := v_successor;
    RETURN NEXT;
  END LOOP;
END
$$;
REVOKE ALL ON FUNCTION private.admin_release_ownership(uuid) FROM PUBLIC, anon, authenticated, service_role;
