SET LOCAL lock_timeout = '5s';

-- M13: server-authorized expense edit and delete (operator decision
-- "Expense edit/delete"). Design: docs/phase1/design.md §A2, §A7 (2, 3),
-- "Review resolutions" DS-1 · ADR-0002.
--
-- Who may edit or delete an expense:
--   - its creator, while an active member of the expense's group;
--   - the group's active owner.
-- Other members get `forbidden`; former members, outsiders and callers
-- naming a nonexistent expense get the identical `not_found_or_forbidden`
-- (authorization is resolved before anything else is read or validated).
--
-- Optimistic concurrency: the caller passes the updated_at it last saw; a
-- mismatch (or NULL) is `stale_expense`. The expense row is locked FOR UPDATE
-- before the comparison, so concurrent edits serialise and the loser is
-- told its view is stale.
--
-- Edits keep the ledger invariants: the group can never change (M1 guard,
-- and no parameter for it); splits are recomputed with the canonical
-- private.equal_split_cents (M12) and replaced in the same transaction, so
-- the deferred balance check (M4) sees a balanced expense at commit. An
-- edit may keep the expense's existing participants and payer even if they
-- have since left the group (their history stays intact), but may only ADD
-- current members.

ALTER TABLE public.expenses
  ADD COLUMN updated_by uuid REFERENCES public.profiles (id) ON DELETE RESTRICT;

-- Resolves an expense for a management RPC: authorization first, then the
-- creator-or-owner rule, then the concurrency check. Returns the locked row.
CREATE FUNCTION private.lock_expense_for_management(p_expense_id uuid, p_expected_updated_at timestamptz)
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

  SELECT * INTO v_expense FROM public.expenses e WHERE e.id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Deleted while we waited.
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
REVOKE ALL ON FUNCTION private.lock_expense_for_management(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.update_equal_split_expense(
  p_expense_id uuid,
  p_expected_updated_at timestamptz,
  p_description text,
  p_amount_cents bigint,
  p_expense_date date,
  p_paid_by uuid,
  p_participant_ids uuid[],
  p_notes text DEFAULT NULL
) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_expense public.expenses;
  v_description text := btrim(coalesce(p_description, ''));
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_count integer;
  v_distinct integer;
  v_updated_at timestamptz;
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

  RETURN v_updated_at;
END
$$;
REVOKE ALL ON FUNCTION public.update_equal_split_expense(uuid, timestamptz, text, bigint, date, uuid, uuid[], text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_equal_split_expense(uuid, timestamptz, text, bigint, date, uuid, uuid[], text)
  TO authenticated;

CREATE FUNCTION public.delete_expense(p_expense_id uuid, p_expected_updated_at timestamptz)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_expense public.expenses;
BEGIN
  v_expense := private.lock_expense_for_management(p_expense_id, p_expected_updated_at);
  -- Splits cascade with their expense; the balance check skips expenses
  -- deleted in the same transaction.
  DELETE FROM public.expenses WHERE id = v_expense.id;
END
$$;
REVOKE ALL ON FUNCTION public.delete_expense(uuid, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_expense(uuid, timestamptz) TO authenticated;
