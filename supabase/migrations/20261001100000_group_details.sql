SET LOCAL lock_timeout = '5s';

-- M24: owners can rename a group and edit its description (Phase 9,
-- operator decision D4; ADR-0013).
--
-- M6 removed the direct UPDATE grant and the "Owners can update groups"
-- policy, so group details had no write path at all. This adds one owner-only
-- SECURITY DEFINER RPC instead of a grant, like every other write:
--   * authorization first (active owner), then the group row is locked
--     FOR UPDATE (the group row first, as every multi-row path takes it since
--     M21) and ownership is re-checked under the lock;
--   * optimistic concurrency: the caller passes the updated_at it read, and a
--     change made in between is refused (stale_group) instead of overwritten;
--   * the existing table CHECKs stay the rules (name 1-80 after trim,
--     description <= 300); the RPC trims, stores an empty description as
--     NULL and maps violations to stable error codes;
--   * an unchanged save is a no-op (no write, no event);
--   * the activity log records 'group_updated' with the changed field names
--     only, never the text (M16 payload privacy rule).
-- No financial table, balance, split or membership is touched.
--
-- Rollback: supabase/rollbacks/20261001100000_group_details.down.sql drops the
-- function and restores the M17 event kinds; it fails while group_updated
-- events exist (the event log is immutable), so once used in production this
-- migration is fix-forward.

ALTER TABLE public.group_events DROP CONSTRAINT group_events_kind_check;
ALTER TABLE public.group_events ADD CONSTRAINT group_events_kind_check CHECK (kind IN ('group_created', 'member_added', 'member_rejoined', 'member_left', 'member_removed', 'member_account_deleted', 'ownership_transferred', 'expense_created', 'expense_updated', 'expense_deleted', 'settlement_recorded', 'settlement_voided', 'group_updated'));

CREATE FUNCTION public.update_group_details(
  p_group_id uuid,
  p_name text,
  p_description text,
  p_expected_updated_at timestamptz
) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
  v_group public.groups%ROWTYPE;
  v_fields text[] := '{}';
  v_updated_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_group_id IS NULL OR NOT private.is_active_owner_of(p_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = 'P0001';
  END IF;
  IF v_description IS NOT NULL AND char_length(v_description) > 300 THEN
    RAISE EXCEPTION 'invalid_description' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_group FROM public.groups g WHERE g.id = p_group_id FOR UPDATE;
  IF NOT FOUND OR NOT private.is_active_owner_of(p_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_updated_at IS NULL OR v_group.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'stale_group' USING ERRCODE = 'P0001';
  END IF;

  IF v_name IS DISTINCT FROM v_group.name THEN
    v_fields := array_append(v_fields, 'name');
  END IF;
  IF v_description IS DISTINCT FROM v_group.description THEN
    v_fields := array_append(v_fields, 'description');
  END IF;
  IF cardinality(v_fields) = 0 THEN
    RETURN v_group.updated_at;
  END IF;

  UPDATE public.groups SET name = v_name, description = v_description
   WHERE id = p_group_id
   RETURNING updated_at INTO v_updated_at;

  PERFORM private.record_group_event(p_group_id, v_uid, 'group_updated', p_group_id, NULL,
    ARRAY[v_uid], jsonb_build_object('fields', to_jsonb(v_fields)));
  RETURN v_updated_at;
END
$$;

REVOKE ALL ON FUNCTION public.update_group_details(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_group_details(uuid, text, text, timestamptz) TO authenticated;
