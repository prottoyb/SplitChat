-- Rollback of M18 (group chat). Removes the table from the Realtime
-- publication, drops the send RPC, the guard and the table, and restores
-- get_ledger_identities verbatim from M16. DISCARDS all chat history: once
-- production has messages, treat M18 as fix-forward (a rollback needs its
-- own approval).

ALTER PUBLICATION supabase_realtime DROP TABLE public.group_messages;
DROP FUNCTION public.send_group_message(uuid, text, uuid);
DROP TABLE public.group_messages;
DROP FUNCTION private.guard_group_messages();

CREATE OR REPLACE FUNCTION public.get_ledger_identities(p_group_id uuid) RETURNS TABLE(user_id uuid, display_name text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;
  IF NOT private.is_active_member_of(p_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  WITH referenced AS (
    SELECT e.paid_by AS uid FROM public.expenses e WHERE e.group_id = p_group_id
    UNION
    SELECT e.created_by FROM public.expenses e WHERE e.group_id = p_group_id
    UNION
    SELECT s.user_id FROM public.expense_splits s
      JOIN public.expenses e ON e.id = s.expense_id
     WHERE e.group_id = p_group_id
    UNION
    SELECT e.updated_by FROM public.expenses e WHERE e.group_id = p_group_id AND e.updated_by IS NOT NULL
    UNION
    SELECT u FROM public.group_events ev, unnest(ev.people) AS u WHERE ev.group_id = p_group_id
  )
  SELECT r.uid, coalesce(nullif(btrim(p.full_name), ''), 'SplitChat member')
    FROM referenced r
    LEFT JOIN public.profiles p ON p.id = r.uid
   WHERE NOT private.is_active_member_of(p_group_id, r.uid);
END
$$;
