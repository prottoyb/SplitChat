SET LOCAL lock_timeout = '5s';

-- M9: membership changes go through authorization-first RPCs (QS-6, AR-5,
-- DS-1, DS-4, CA-1). Design: docs/phase1/design.md §A2, §A4, §A5, §A7,
-- "Review resolutions" · ADR-0004.
--
-- Every RPC first checks the caller (auth_required), then the caller's
-- right to act on the group, and raises the SAME not_found_or_forbidden for
-- a missing group, a non-member and a non-owner, before looking at any
-- target argument. Target-level outcomes are visible to the owner only.
--
--   add_group_member_by_email(group, email) -> (result, added_user_id,
--       added_full_name, added_role)
--     result: added | already_member | member_not_added | rate_limited.
--     Non-authorization outcomes are RETURNED, not raised, so the rate-limit
--     attempt row commits (CA-1). Identity columns are set only for
--     `added` (DS-4). Only confirmed, non-deleted accounts can be added;
--     "no account" and "unconfirmed" are the same outcome. A former member
--     is reactivated. 20 attempts per caller per hour, counting every
--     attempt (successful or not) and serialised per caller.
--   remove_group_member(group, user): owner only; marks the row removed.
--   leave_group(group): active member; an owner must transfer first.
--   transfer_group_ownership(group, new_owner): owner only; the new owner
--     must be another active member; demote then promote under row locks.
-- Error codes: SQLSTATE P0001 with a stable snake_case message.
-- The frontend change ships with this migration (same commit series).

CREATE TABLE private.member_add_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  caller_id uuid NOT NULL,
  group_id uuid NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX member_add_attempts_caller_time_idx
  ON private.member_add_attempts (caller_id, attempted_at);
ALTER TABLE private.member_add_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.member_add_attempts FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION public.add_group_member_by_email(uuid, text);

CREATE FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text)
RETURNS TABLE(result text, added_user_id uuid, added_full_name text, added_role text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_attempts integer;
  v_target uuid;
  v_name text;
  v_left_at timestamptz;
  v_found boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;
  IF target_group_id IS NULL OR NOT private.is_active_owner_of(target_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;

  v_email := lower(btrim(coalesce(target_email, '')));
  IF char_length(v_email) NOT BETWEEN 3 AND 320 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'invalid_email' USING ERRCODE = 'P0001';
  END IF;

  -- Serialise attempts per caller so concurrent calls cannot all pass the
  -- count before any insert commits (review B2-QS-1). Transaction-scoped.
  PERFORM pg_advisory_xact_lock(hashtextextended('splitchat.member_add_attempts:' || v_uid::text, 0));

  DELETE FROM private.member_add_attempts
   WHERE caller_id = v_uid AND attempted_at < now() - interval '1 day';
  SELECT count(*) INTO v_attempts FROM private.member_add_attempts
   WHERE caller_id = v_uid AND attempted_at > now() - interval '1 hour';
  IF v_attempts >= 20 THEN
    RETURN QUERY SELECT 'rate_limited'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;
  INSERT INTO private.member_add_attempts (caller_id, group_id) VALUES (v_uid, target_group_id);

  SELECT u.id, coalesce(nullif(btrim(p.full_name), ''), split_part(u.email, '@', 1))
    INTO v_target, v_name
    FROM auth.users u
    JOIN public.profiles p ON p.id = u.id
   WHERE lower(u.email) = v_email
     AND u.email_confirmed_at IS NOT NULL
     AND u.deleted_at IS NULL
   LIMIT 1;

  IF v_target IS NULL THEN
    RETURN QUERY SELECT 'member_not_added'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT true, gm.left_at INTO v_found, v_left_at
    FROM public.group_members gm
   WHERE gm.group_id = target_group_id AND gm.user_id = v_target
   FOR UPDATE;

  IF v_found AND v_left_at IS NULL THEN
    RETURN QUERY SELECT 'already_member'::text, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_found THEN
    UPDATE public.group_members
       SET left_at = NULL, left_reason = NULL, removed_by = NULL,
           role = 'member', joined_at = now()
     WHERE group_id = target_group_id AND user_id = v_target;
  ELSE
    BEGIN
      INSERT INTO public.group_members (group_id, user_id, role)
      VALUES (target_group_id, v_target, 'member');
    EXCEPTION WHEN unique_violation THEN
      RETURN QUERY SELECT 'already_member'::text, NULL::uuid, NULL::text, NULL::text;
      RETURN;
    END;
  END IF;

  RETURN QUERY SELECT 'added'::text, v_target, v_name, 'member'::text;
END
$$;

CREATE FUNCTION public.remove_group_member(p_group_id uuid, p_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_group_id IS NULL OR NOT private.is_active_owner_of(p_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF p_user_id = v_uid THEN
    RAISE EXCEPTION 'cannot_remove_owner' USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1 FROM public.group_members gm
   WHERE gm.group_id = p_group_id AND gm.user_id = p_user_id AND gm.left_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.group_members
     SET left_at = now(), left_reason = 'removed', removed_by = v_uid
   WHERE group_id = p_group_id AND user_id = p_user_id;
END
$$;

CREATE FUNCTION public.leave_group(p_group_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;

  SELECT gm.role INTO v_role
    FROM public.group_members gm
   WHERE gm.group_id = p_group_id AND gm.user_id = v_uid AND gm.left_at IS NULL
   FOR UPDATE;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF v_role = 'owner' THEN
    RAISE EXCEPTION 'owner_must_transfer' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.group_members
     SET left_at = now(), left_reason = 'left'
   WHERE group_id = p_group_id AND user_id = v_uid;
END
$$;

CREATE FUNCTION public.transfer_group_ownership(p_group_id uuid, p_new_owner_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_group_id IS NULL OR NOT private.is_active_owner_of(p_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;

  -- Lock both rows in a stable order, then re-check under the lock.
  PERFORM 1 FROM public.group_members gm
   WHERE gm.group_id = p_group_id AND gm.user_id IN (v_uid, p_new_owner_id)
   ORDER BY gm.user_id
   FOR UPDATE;
  IF NOT private.is_active_owner_of(p_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF p_new_owner_id IS NULL OR p_new_owner_id = v_uid
     OR NOT private.is_active_member_of(p_group_id, p_new_owner_id) THEN
    RAISE EXCEPTION 'invalid_new_owner' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.group_members SET role = 'member'
   WHERE group_id = p_group_id AND user_id = v_uid;
  UPDATE public.group_members SET role = 'owner'
   WHERE group_id = p_group_id AND user_id = p_new_owner_id;
END
$$;

REVOKE ALL ON FUNCTION public.add_group_member_by_email(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.remove_group_member(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.leave_group(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.transfer_group_ownership(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_group_member_by_email(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_group_member(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_group(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_group_ownership(uuid, uuid) TO authenticated;
