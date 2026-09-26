SET LOCAL lock_timeout = '5s';

-- M12: integer cents at the API boundary and one canonical equal-split rule
-- (QS-7, AR-6, AR-7). Design: docs/phase1/design.md §A7, §A8 · ADR-0006.
--
--  - expenses.amount_cents / expense_splits.share_cents: generated, stored
--    bigint columns derived from the exact numeric(12,2) storage (exact:
--    scale 2 guarantees the cast never rounds). Existing ledger values are
--    NOT rewritten; the new columns are derived from them. Adding a stored
--    generated column rewrites each table once under a brief exclusive lock.
--  - private.equal_split_cents(total, participants): the single canonical
--    allocation. Participants are de-duplicated and sorted ascending by
--    UUID; each gets floor(total / n); the first total % n in that order get
--    one extra cent. src/lib/expenseSplit.ts implements the same rule and
--    both are tested against src/lib/fixtures/equal-split-vectors.json.
--  - create_equal_split_expense_v2(... p_amount_cents bigint ...): the
--    reviewed RPC. Authorization first (not_found_or_forbidden), then
--    structured error codes (SQLSTATE P0001, snake_case message).
--  - The legacy numeric RPC becomes a thin wrapper around v2 (kept until the
--    v2 frontend is in use; dropped in M14). Its remainder order becomes the
--    canonical one and its errors become v2's codes.

ALTER TABLE public.expenses
  ADD COLUMN amount_cents bigint GENERATED ALWAYS AS ((amount * 100)::bigint) STORED;
ALTER TABLE public.expense_splits
  ADD COLUMN share_cents bigint GENERATED ALWAYS AS ((share_amount * 100)::bigint) STORED;

-- Errors (same codes as allocateEqualSplit): invalid_amount (null, <= 0,
-- > 999999999999), invalid_participants (null/empty array or a null
-- element), amount_too_small_to_split (fewer cents than distinct
-- participants). Duplicates are removed before allocation.
CREATE FUNCTION private.equal_split_cents(p_total_cents bigint, p_participant_ids uuid[])
RETURNS TABLE(user_id uuid, share_cents bigint)
LANGUAGE plpgsql IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_n bigint;
BEGIN
  IF p_total_cents IS NULL OR p_total_cents <= 0 OR p_total_cents > 999999999999 THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = 'P0001';
  END IF;
  IF coalesce(cardinality(p_participant_ids), 0) = 0 OR array_position(p_participant_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_participants' USING ERRCODE = 'P0001';
  END IF;
  SELECT count(DISTINCT p) INTO v_n FROM unnest(p_participant_ids) AS p;
  IF p_total_cents < v_n THEN
    RAISE EXCEPTION 'amount_too_small_to_split' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
    SELECT o.id,
           p_total_cents / v_n + CASE WHEN o.position <= p_total_cents % v_n THEN 1 ELSE 0 END
      FROM (SELECT d.id, row_number() OVER (ORDER BY d.id) AS position
              FROM (SELECT DISTINCT p AS id FROM unnest(p_participant_ids) AS p) d) o
     ORDER BY o.id;
END
$$;
REVOKE ALL ON FUNCTION private.equal_split_cents(bigint, uuid[]) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_equal_split_expense_v2(
  p_group_id uuid,
  p_description text,
  p_amount_cents bigint,
  p_expense_date date,
  p_paid_by uuid,
  p_participant_ids uuid[],
  p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
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

  RETURN v_expense_id;
END
$$;
REVOKE ALL ON FUNCTION public.create_equal_split_expense_v2(uuid, text, bigint, date, uuid, uuid[], text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_equal_split_expense_v2(uuid, text, bigint, date, uuid, uuid[], text)
  TO authenticated;

-- Legacy entry point: same signature and grants, now a wrapper around v2.
CREATE OR REPLACE FUNCTION public.create_equal_split_expense(
  p_group_id uuid,
  p_description text,
  p_amount numeric,
  p_expense_date date,
  p_paid_by uuid,
  p_participant_ids uuid[],
  p_notes text DEFAULT NULL::text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cents bigint;
BEGIN
  -- An amount that is not a whole number of cents, or is out of range, is
  -- passed on as -1 so v2 reports invalid_amount in its own check order
  -- (authentication and authorization first) and the conversion below can
  -- never overflow.
  IF p_amount IS NULL THEN
    v_cents := NULL;
  ELSIF p_amount <> round(p_amount, 2) OR p_amount <= 0 OR p_amount > 9999999999.99 THEN
    v_cents := -1;
  ELSE
    v_cents := (p_amount * 100)::bigint;
  END IF;
  -- The legacy RPC silently removed duplicate and null participants.
  RETURN public.create_equal_split_expense_v2(
    p_group_id, p_description, v_cents,
    p_expense_date, p_paid_by,
    ARRAY(SELECT DISTINCT p FROM unnest(p_participant_ids) AS p WHERE p IS NOT NULL),
    p_notes);
END
$$;
