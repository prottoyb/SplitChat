-- Rollback of M14: recreates the legacy numeric expense RPC exactly as M12
-- left it (a wrapper around create_equal_split_expense_v2), with the same
-- grants and comment, for a frontend older than a5ed4e8.
CREATE FUNCTION public.create_equal_split_expense(
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
-- Grants as they stood before M14 (authenticated, plus the platform's
-- baseline service_role grant, which no migration removed).
REVOKE ALL ON FUNCTION public.create_equal_split_expense(uuid, text, numeric, date, uuid, uuid[], text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_equal_split_expense(uuid, text, numeric, date, uuid, uuid[], text)
  TO authenticated, service_role;
COMMENT ON FUNCTION public.create_equal_split_expense(uuid, text, numeric, date, uuid, uuid[], text)
  IS 'Creates one SplitChat expense and its equal participant splits atomically.';
