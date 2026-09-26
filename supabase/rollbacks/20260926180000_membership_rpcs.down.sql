-- Rollback of M9. Recovery only: restores the pre-M9 add-by-email RPC (which
-- discloses whether an email is registered, QS-6) and removes the
-- membership RPCs. Generated verbatim from the post-M8 schema. In
-- production, apply as a new forward migration under its own approval.
DROP FUNCTION public.transfer_group_ownership(uuid, uuid);
DROP FUNCTION public.leave_group(uuid);
DROP FUNCTION public.remove_group_member(uuid, uuid);
DROP FUNCTION public.add_group_member_by_email(uuid, text);
DROP TABLE private.member_add_attempts;

CREATE FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text) RETURNS TABLE(added_user_id uuid, added_full_name text, added_role text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  current_user_id uuid;
  found_user_id uuid;
  found_full_name text;
  clean_email text;
begin

  -- -------------------------------------------------------
  -- 1. Identify caller
  -- -------------------------------------------------------

  current_user_id := (select auth.uid());

  if current_user_id is null then
    raise exception 'Authentication required.';
  end if;


  -- -------------------------------------------------------
  -- 2. Validate email
  -- -------------------------------------------------------

  clean_email := lower(btrim(coalesce(target_email, '')));

  if clean_email = '' then
    raise exception 'Please enter an email address.';
  end if;


  -- -------------------------------------------------------
  -- 3. Verify caller owns this group
  --
  -- Important: ownership is checked BEFORE looking up
  -- another user's email.
  -- -------------------------------------------------------

  if not exists (
    select 1
    from public.groups g
    where g.id = target_group_id
      and g.created_by = current_user_id
  ) then
    raise exception 'Only the group owner can add members.';
  end if;


  -- -------------------------------------------------------
  -- 4. Find registered SplitChat user
  -- -------------------------------------------------------

  select
    u.id,
    coalesce(
      nullif(btrim(p.full_name), ''),
      split_part(coalesce(u.email, ''), '@', 1)
    )
  into
    found_user_id,
    found_full_name
  from auth.users u
  left join public.profiles p
    on p.id = u.id
  where lower(u.email) = clean_email
  limit 1;


  if found_user_id is null then
    raise exception 'No SplitChat account was found for that email address.';
  end if;


  -- -------------------------------------------------------
  -- 5. Prevent owner adding themselves again
  -- -------------------------------------------------------

  if found_user_id = current_user_id then
    raise exception 'You are already the owner of this group.';
  end if;


  -- -------------------------------------------------------
  -- 6. Prevent duplicate membership
  -- -------------------------------------------------------

  if exists (
    select 1
    from public.group_members gm
    where gm.group_id = target_group_id
      and gm.user_id = found_user_id
  ) then
    raise exception 'This user is already a member of the group.';
  end if;


  -- -------------------------------------------------------
  -- 7. Add member
  --
  -- Role is deliberately hard-coded to member.
  -- Browser clients cannot create another owner.
  -- -------------------------------------------------------

  insert into public.group_members (
    group_id,
    user_id,
    role
  )
  values (
    target_group_id,
    found_user_id,
    'member'
  );


  -- -------------------------------------------------------
  -- 8. Return safe application-facing information
  -- -------------------------------------------------------

  return query
  select
    found_user_id,
    found_full_name,
    'member'::text;

end;
$$;



REVOKE ALL ON FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text) TO authenticated;
GRANT ALL ON FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text) TO service_role;
