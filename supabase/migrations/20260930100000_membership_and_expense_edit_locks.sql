SET LOCAL lock_timeout = '5s';

-- M21: one lock discipline for membership changes and expense edits
-- (Phase 8, following M20).
--
-- Races fixed (all pre-existing):
--  - update_equal_split_expense checked the payer and participants were
--    members without locking them: an edit could add someone whose removal
--    committed at the same moment.
--  - update/delete authority (creator while a member, or the owner) was
--    checked without locking the caller's membership: an edit or delete could
--    complete after the caller was removed, left or handed over ownership.
--  - record_settlement / void_settlement re-check the caller under the group
--    row lock, but remove/leave/transfer never took that lock, so the re-check
--    did not serialise with them.
--
-- The rule now: every path that changes memberships or acts on a member's
-- authority takes the group row first (remove/leave/transfer: FOR KEY SHARE,
-- which conflicts with the settlement RPCs' FOR UPDATE and nothing else),
-- then membership rows in user_id order. Expense edit/delete: group
-- FOR KEY SHARE -> expense FOR UPDATE -> caller's membership FOR SHARE
-- (re-check authority) -> payer/participants FOR SHARE (re-check). This is the
-- order of delete_group, add_group_member_by_email, the settlement RPCs, the
-- expense core (M20) and the candidate RPCs (M19), so no lock cycle is added.
-- A lock-order alternative (membership locks inside the settlement RPCs) was
-- rejected: it deadlocks with removal/transfer, which hold a membership row
-- and then need the group row for their event.
--
-- Function contracts, error codes and events are unchanged; only race
-- outcomes change (the later action waits, then is refused if its premise no
-- longer holds).
--
-- Rollback: restore the previous definitions (supabase/rollbacks). Safe at
-- any time; no data changes.

CREATE OR REPLACE FUNCTION private.lock_expense_for_management(p_expense_id uuid, p_expected_updated_at timestamptz)
RETURNS public.expenses
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_group_id uuid;
  v_expense public.expenses;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;

  -- Unlocked lookup first, so a caller outside the group can never take (or
  -- wait on) a lock on the row.
  SELECT e.group_id INTO v_group_id FROM public.expenses e WHERE e.id = p_expense_id;
  IF v_group_id IS NULL OR NOT private.is_active_member_of(v_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;

  -- M21: the group row first (key share), as every multi-row path does.
  PERFORM 1 FROM public.groups g WHERE g.id = v_group_id FOR KEY SHARE;
  SELECT * INTO v_expense FROM public.expenses e WHERE e.id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Deleted while we waited.
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;

  -- M21: hold the caller's membership while deciding (a removal, leave or
  -- ownership transfer serialises with this edit or delete).
  PERFORM private.share_lock_memberships(v_group_id, ARRAY[v_uid]);
  IF NOT private.is_active_member_of(v_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;

  IF v_expense.created_by IS DISTINCT FROM v_uid AND NOT private.is_active_owner_of(v_expense.group_id, v_uid) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001';
  END IF;

  IF p_expected_updated_at IS NULL OR v_expense.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'stale_expense' USING ERRCODE = 'P0001';
  END IF;

  RETURN v_expense;
END
$$;

CREATE OR REPLACE FUNCTION public.update_equal_split_expense(p_expense_id uuid, p_expected_updated_at timestamp with time zone, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text DEFAULT NULL::text) RETURNS timestamp with time zone
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_expense public.expenses;
  v_description text := btrim(coalesce(p_description, ''));
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_count integer;
  v_distinct integer;
  v_updated_at timestamptz;
  v_before_participants uuid[];
  v_changes jsonb := '{}'::jsonb;
BEGIN
  v_expense := private.lock_expense_for_management(p_expense_id, p_expected_updated_at);

  IF char_length(v_description) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'invalid_description' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 999999999999 THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = 'P0001';
  END IF;
  IF p_expense_date IS NULL THEN
    RAISE EXCEPTION 'invalid_date' USING ERRCODE = 'P0001';
  END IF;
  -- The payer may stay as recorded, or change to a current member.
  IF p_paid_by IS NULL
     OR (p_paid_by IS DISTINCT FROM v_expense.paid_by
         AND NOT private.is_active_member_of(v_expense.group_id, p_paid_by)) THEN
    RAISE EXCEPTION 'invalid_payer' USING ERRCODE = 'P0001';
  END IF;

  -- Participants: distinct, non-null, each a current member or already a
  -- participant of this expense.
  v_count := coalesce(cardinality(p_participant_ids), 0);
  SELECT count(DISTINCT p) INTO v_distinct FROM unnest(p_participant_ids) AS p WHERE p IS NOT NULL;
  IF v_count = 0 OR v_distinct <> v_count
     OR EXISTS (SELECT 1 FROM unnest(p_participant_ids) AS p
                 WHERE NOT private.is_active_member_of(v_expense.group_id, p)
                   AND NOT EXISTS (SELECT 1 FROM public.expense_splits s
                                    WHERE s.expense_id = v_expense.id AND s.user_id = p)) THEN
    RAISE EXCEPTION 'invalid_participants' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount_cents < v_count THEN
    RAISE EXCEPTION 'amount_too_small_to_split' USING ERRCODE = 'P0001';
  END IF;
  IF v_notes IS NOT NULL AND char_length(v_notes) > 500 THEN
    RAISE EXCEPTION 'invalid_notes' USING ERRCODE = 'P0001';
  END IF;

  -- M21: hold the payer and participants who are members until this commits,
  -- and re-check the rules under the locks (a removal that committed first
  -- makes a newly added former member invalid).
  PERFORM private.share_lock_memberships(v_expense.group_id, ARRAY[p_paid_by] || p_participant_ids);
  IF p_paid_by IS DISTINCT FROM v_expense.paid_by AND NOT private.is_active_member_of(v_expense.group_id, p_paid_by) THEN
    RAISE EXCEPTION 'invalid_payer' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_participant_ids) AS p
              WHERE NOT private.is_active_member_of(v_expense.group_id, p)
                AND NOT EXISTS (SELECT 1 FROM public.expense_splits s
                                 WHERE s.expense_id = v_expense.id AND s.user_id = p)) THEN
    RAISE EXCEPTION 'invalid_participants' USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(s.user_id ORDER BY s.user_id) INTO v_before_participants
    FROM public.expense_splits s WHERE s.expense_id = v_expense.id;

  UPDATE public.expenses
     SET description = v_description,
         amount = (p_amount_cents::numeric / 100)::numeric(12, 2),
         expense_date = p_expense_date,
         paid_by = p_paid_by,
         notes = v_notes,
         updated_by = v_uid
   WHERE id = v_expense.id
  RETURNING updated_at INTO v_updated_at;

  DELETE FROM public.expense_splits WHERE expense_id = v_expense.id;
  INSERT INTO public.expense_splits (expense_id, user_id, share_amount, percentage)
  SELECT v_expense.id, s.user_id, (s.share_cents::numeric / 100)::numeric(12, 2), NULL
    FROM private.equal_split_cents(p_amount_cents, p_participant_ids) s;

  -- Before/after of changed fields only; description and notes are flagged,
  -- never copied (ADR-0009 condition 4).
  IF v_expense.amount_cents IS DISTINCT FROM p_amount_cents THEN
    v_changes := v_changes || jsonb_build_object('amount_cents', jsonb_build_object('from', v_expense.amount_cents, 'to', p_amount_cents));
  END IF;
  IF v_expense.expense_date IS DISTINCT FROM p_expense_date THEN
    v_changes := v_changes || jsonb_build_object('expense_date', jsonb_build_object('from', v_expense.expense_date, 'to', p_expense_date));
  END IF;
  IF v_expense.paid_by IS DISTINCT FROM p_paid_by THEN
    v_changes := v_changes || jsonb_build_object('paid_by', jsonb_build_object('from', v_expense.paid_by, 'to', p_paid_by));
  END IF;
  IF v_before_participants IS DISTINCT FROM (SELECT array_agg(p ORDER BY p) FROM unnest(p_participant_ids) AS p) THEN
    v_changes := v_changes || jsonb_build_object('participants', jsonb_build_object(
      'from', to_jsonb(v_before_participants),
      'to', (SELECT to_jsonb(array_agg(p ORDER BY p)) FROM unnest(p_participant_ids) AS p)));
  END IF;
  PERFORM private.record_group_event(v_expense.group_id, v_uid, 'expense_updated', v_expense.id, NULL,
    v_before_participants || p_participant_ids || v_expense.paid_by || p_paid_by,
    jsonb_build_object('changes', v_changes,
                       'description_changed', v_expense.description IS DISTINCT FROM v_description,
                       'notes_changed', v_expense.notes IS DISTINCT FROM v_notes));

  RETURN v_updated_at;
END
$$;

CREATE OR REPLACE FUNCTION public.remove_group_member(p_group_id uuid, p_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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

  -- M21: the group row first (key share), as every multi-row path does.
  PERFORM 1 FROM public.groups g WHERE g.id = p_group_id FOR KEY SHARE;
  PERFORM 1 FROM public.group_members gm
   WHERE gm.group_id = p_group_id AND gm.user_id = p_user_id AND gm.left_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.group_members
     SET left_at = now(), left_reason = 'removed', removed_by = v_uid
   WHERE group_id = p_group_id AND user_id = p_user_id;

  PERFORM private.record_group_event(p_group_id, v_uid, 'member_removed', NULL, p_user_id, NULL);
END
$$;

CREATE OR REPLACE FUNCTION public.leave_group(p_group_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;

  -- M21: the group row first (key share), as every multi-row path does.
  PERFORM 1 FROM public.groups g WHERE g.id = p_group_id FOR KEY SHARE;
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

  PERFORM private.record_group_event(p_group_id, v_uid, 'member_left', NULL, v_uid, NULL);
END
$$;

CREATE OR REPLACE FUNCTION public.transfer_group_ownership(p_group_id uuid, p_new_owner_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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

  -- M21: the group row first (key share), as every multi-row path does.
  PERFORM 1 FROM public.groups g WHERE g.id = p_group_id FOR KEY SHARE;
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

  PERFORM private.record_group_event(p_group_id, v_uid, 'ownership_transferred', NULL, p_new_owner_id,
    ARRAY[v_uid, p_new_owner_id], jsonb_build_object('from', v_uid, 'to', p_new_owner_id));
END
$$;
