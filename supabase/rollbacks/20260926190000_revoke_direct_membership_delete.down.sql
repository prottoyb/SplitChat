-- Rollback of M10. Recovery only: restores direct hard-delete of
-- memberships. In production, apply as a new forward migration under its
-- own approval.
CREATE FUNCTION private.my_owned_group_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT gm.group_id FROM public.group_members gm
   WHERE gm.user_id = (SELECT auth.uid()) AND gm.role = 'owner' AND gm.left_at IS NULL
$$;
REVOKE ALL ON FUNCTION private.my_owned_group_ids() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.my_owned_group_ids() TO authenticated;

CREATE POLICY "Owners can remove members and members can leave" ON public.group_members
  FOR DELETE TO authenticated
  USING (
    (group_id IN (SELECT private.my_owned_group_ids()) AND user_id <> (SELECT auth.uid()))
    OR (user_id = (SELECT auth.uid()) AND group_id NOT IN (SELECT private.my_owned_group_ids()))
  );

GRANT DELETE ON public.group_members TO authenticated;
