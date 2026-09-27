-- Rollback of M17 (settlements). Restores delete_group verbatim from M15 and
-- the M16 event kinds, then drops the settlement functions and table.
-- DISCARDS all settlement history, and fails while settlement events exist
-- (the event log is immutable): once settlements exist in production, treat
-- M17 as fix-forward (a rollback needs its own approval).

CREATE OR REPLACE FUNCTION public.delete_group(p_group_id uuid) RETURNS void
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

DROP FUNCTION public.void_settlement(uuid, text);
DROP FUNCTION public.record_settlement(uuid, uuid, uuid, bigint, date, text, uuid);
DROP FUNCTION public.get_group_balances(uuid);
DROP FUNCTION private.group_balances(uuid);

ALTER TABLE public.group_events DROP CONSTRAINT group_events_kind_check;
ALTER TABLE public.group_events ADD CONSTRAINT group_events_kind_check CHECK (kind IN ('group_created', 'member_added', 'member_rejoined', 'member_left', 'member_removed', 'member_account_deleted', 'ownership_transferred', 'expense_created', 'expense_updated', 'expense_deleted'));

DROP TABLE public.settlements;
DROP FUNCTION private.guard_settlements();
