-- Rollback of M19 (Smart Expense candidates). Removes the table from the
-- Realtime publication, drops the candidate RPCs, helpers, guard and table,
-- restores create_equal_split_expense_v2 verbatim from M16, then drops the
-- private core and the (id, group_id) constraint on group_messages.
-- DISCARDS all candidates: once production has candidates, treat M19 as
-- fix-forward (a rollback needs its own approval).

ALTER PUBLICATION supabase_realtime DROP TABLE public.expense_candidates;
DROP FUNCTION public.approve_expense_candidate(uuid, integer);
DROP FUNCTION public.reject_expense_candidate(uuid, integer);
DROP FUNCTION public.update_expense_candidate(uuid, integer, text, bigint, date, uuid, uuid[], text);
DROP FUNCTION public.propose_expense_candidate(bigint, text, text, text, bigint, date, uuid, uuid[], text);
DROP FUNCTION private.lock_candidate(uuid, uuid);
DROP FUNCTION private.can_manage_candidate(public.expense_candidates, uuid);
DROP FUNCTION private.share_lock_memberships(uuid, uuid[]);
DROP FUNCTION private.check_candidate_draft(uuid, text, bigint, date, uuid, uuid[], text);
DROP TABLE public.expense_candidates;
DROP FUNCTION private.guard_expense_candidates();

CREATE OR REPLACE FUNCTION public.create_equal_split_expense_v2(p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_description text := btrim(coalesce(p_description, ''));
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_count integer;
  v_distinct integer;
  v_expense_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_group_id IS NULL OR NOT private.is_active_member_of(p_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(v_description) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'invalid_description' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 999999999999 THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = 'P0001';
  END IF;
  IF p_expense_date IS NULL THEN
    RAISE EXCEPTION 'invalid_date' USING ERRCODE = 'P0001';
  END IF;
  IF p_paid_by IS NULL OR NOT private.is_active_member_of(p_group_id, p_paid_by) THEN
    RAISE EXCEPTION 'invalid_payer' USING ERRCODE = 'P0001';
  END IF;

  v_count := coalesce(cardinality(p_participant_ids), 0);
  SELECT count(DISTINCT p) INTO v_distinct FROM unnest(p_participant_ids) AS p WHERE p IS NOT NULL;
  IF v_count = 0 OR v_distinct <> v_count
     OR EXISTS (SELECT 1 FROM unnest(p_participant_ids) AS p
                 WHERE NOT private.is_active_member_of(p_group_id, p)) THEN
    RAISE EXCEPTION 'invalid_participants' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount_cents < v_count THEN
    RAISE EXCEPTION 'amount_too_small_to_split' USING ERRCODE = 'P0001';
  END IF;
  IF v_notes IS NOT NULL AND char_length(v_notes) > 500 THEN
    RAISE EXCEPTION 'invalid_notes' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.expenses (group_id, description, amount, expense_date, paid_by, created_by, split_type, notes)
  VALUES (p_group_id, v_description, (p_amount_cents::numeric / 100)::numeric(12, 2), p_expense_date,
          p_paid_by, v_uid, 'equal', v_notes)
  RETURNING id INTO v_expense_id;

  INSERT INTO public.expense_splits (expense_id, user_id, share_amount, percentage)
  SELECT v_expense_id, s.user_id, (s.share_cents::numeric / 100)::numeric(12, 2), NULL
    FROM private.equal_split_cents(p_amount_cents, p_participant_ids) s;

  PERFORM private.record_group_event(p_group_id, v_uid, 'expense_created', v_expense_id, NULL,
    p_participant_ids || p_paid_by,
    jsonb_build_object('amount_cents', p_amount_cents, 'expense_date', p_expense_date, 'paid_by', p_paid_by,
                       'participants', (SELECT to_jsonb(array_agg(p ORDER BY p)) FROM unnest(p_participant_ids) AS p)));

  RETURN v_expense_id;
END
$$;

DROP FUNCTION private.create_equal_split_expense_core(uuid, uuid, text, bigint, date, uuid, uuid[], text, jsonb);
ALTER TABLE public.group_messages DROP CONSTRAINT group_messages_id_group_key;
