SET LOCAL lock_timeout = '5s';

-- M15: permanent deletion of a genuinely private, solo group (operator
-- decision "sole-member group deletion is a separate explicit flow";
-- approved M15 rule, 2026-09-26). Design: docs/phase1/design.md §A2, §A7 (8),
-- DS-1, DS-9 · ADR-0004.
--
-- A group may be deleted only by its active owner, and only when:
--   1. the owner is the only person who has EVER been a member: any other
--      membership row, active or former (left, removed, account_deleted),
--      refuses with group_has_other_members; and
--   2. no record in the group refers to anyone else: an expense paid,
--      created or last edited by another user, a split for another user, a
--      membership removed_by another user, or a group created by another
--      user refuses with group_has_shared_history. This check is
--      independent of (1): memberships hard-deleted before M7/M10 left no
--      row, but their financial history still counts.
-- Current active-member count alone is never sufficient. A solo ledger
-- (expenses involving only the owner) may be deleted with the group; shared
-- financial history can never be destroyed through this RPC.
--
-- Authorization first (DS-1): a missing group and a group the caller does
-- not actively own give the identical not_found_or_forbidden; the history
-- checks are reachable only by the owner.
--
-- Concurrency: the group row is locked FOR UPDATE before the checks. A
-- concurrent membership or expense insert needs a key-share lock on the
-- same row (foreign key), so it either commits first and is seen by the
-- checks, or waits and then fails because the group is gone.
--
-- Not deleted: private.member_add_attempts rows. They are the caller's
-- add-by-email rate-limit history; deleting them with the group would let
-- create-probe-delete reset the enumeration limit (CA-1).

CREATE FUNCTION public.delete_group(p_group_id uuid) RETURNS void
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

  PERFORM 1 FROM public.groups g WHERE g.id = p_group_id FOR UPDATE;
  PERFORM 1 FROM public.group_members gm WHERE gm.group_id = p_group_id ORDER BY gm.user_id FOR UPDATE;
  -- Re-check under the locks (ownership may have changed while we waited).
  IF NOT private.is_active_owner_of(p_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM public.group_members gm
              WHERE gm.group_id = p_group_id AND gm.user_id <> v_uid) THEN
    RAISE EXCEPTION 'group_has_other_members' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM public.groups g
              WHERE g.id = p_group_id AND g.created_by <> v_uid)
     OR EXISTS (SELECT 1 FROM public.group_members gm
                 WHERE gm.group_id = p_group_id AND gm.removed_by IS NOT NULL AND gm.removed_by <> v_uid)
     OR EXISTS (SELECT 1 FROM public.expenses e
                 WHERE e.group_id = p_group_id
                   AND (e.paid_by <> v_uid OR e.created_by <> v_uid
                        OR (e.updated_by IS NOT NULL AND e.updated_by <> v_uid)))
     OR EXISTS (SELECT 1 FROM public.expense_splits s
                  JOIN public.expenses e ON e.id = s.expense_id
                 WHERE e.group_id = p_group_id AND s.user_id <> v_uid) THEN
    RAISE EXCEPTION 'group_has_shared_history' USING ERRCODE = 'P0001';
  END IF;

  -- Splits cascade with their expenses; the deferred balance check skips
  -- expenses deleted in the same transaction.
  DELETE FROM public.expenses WHERE group_id = p_group_id;
  DELETE FROM public.group_members WHERE group_id = p_group_id;
  DELETE FROM public.groups WHERE id = p_group_id;
END
$$;
REVOKE ALL ON FUNCTION public.delete_group(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_group(uuid) TO authenticated;
