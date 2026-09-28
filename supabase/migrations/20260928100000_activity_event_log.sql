SET LOCAL lock_timeout = '5s';

-- M16: append-only activity event log (ADR-0009, operator-approved
-- 2026-09-27; Software Architect conditions 1-13). Feed and audit only:
-- balances, settlements and Smart Expense candidates are never derived from
-- events.
--
--  - public.group_events: one row per meaningful change in a group, written
--    by the existing SECURITY DEFINER functions (and the group/auth
--    triggers) in the same transaction as the change, through
--    private.record_group_event. Clients can only SELECT, and only for
--    groups they are an active member of (same rule as every other table).
--  - Payload privacy: ids, integer cents, dates and people ids only - never
--    names, emails, notes or descriptions (not even for deletions: operator
--    decision). Names are resolved at read time, so account-deletion
--    tombstones apply. `people` lists every person id the event refers to,
--    so get_ledger_identities can name former members.
--  - Immutable: UPDATE is refused (except the ON DELETE SET NULL of a
--    deleted actor profile); DELETE only through the group-delete cascade.
--  - delete_group (solo groups only) records nothing; the group's events
--    cascade away with it.
--  - Backfill: existing groups, memberships and expenses get synthesized
--    events marked backfilled = true (history before go-live is incomplete:
--    earlier deletions, edits and transfers cannot be recovered).

CREATE TABLE public.group_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES public.groups (id) ON DELETE CASCADE,
  actor_id uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  kind text NOT NULL,
  subject_id uuid,
  subject_user_id uuid,
  people uuid[] NOT NULL DEFAULT '{}',
  payload jsonb NOT NULL,
  backfilled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_events_kind_check CHECK (kind IN (
    'group_created', 'member_added', 'member_rejoined', 'member_left', 'member_removed',
    'member_account_deleted', 'ownership_transferred',
    'expense_created', 'expense_updated', 'expense_deleted')),
  CONSTRAINT group_events_payload_check CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'v')
);
CREATE INDEX group_events_group_created_idx ON public.group_events (group_id, created_at DESC, id DESC);

ALTER TABLE public.group_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.group_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.group_events TO authenticated;
CREATE POLICY "Members can view group events" ON public.group_events
  FOR SELECT TO authenticated
  USING (group_id IN (SELECT private.my_active_group_ids()));

-- Immutability (condition 7).
CREATE FUNCTION private.guard_group_events() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Only the FK action that clears the actor of a deleted profile.
    IF NEW.actor_id IS NULL AND OLD.actor_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = OLD.actor_id)
       AND (NEW.id, NEW.group_id, NEW.kind, NEW.subject_id, NEW.subject_user_id, NEW.people,
            NEW.payload, NEW.backfilled, NEW.created_at)
           IS NOT DISTINCT FROM
           (OLD.id, OLD.group_id, OLD.kind, OLD.subject_id, OLD.subject_user_id, OLD.people,
            OLD.payload, OLD.backfilled, OLD.created_at) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'group_events_immutable' USING ERRCODE = 'P0001';
  END IF;
  -- DELETE: only as part of deleting the group itself (the cascade).
  IF EXISTS (SELECT 1 FROM public.groups g WHERE g.id = OLD.group_id) THEN
    RAISE EXCEPTION 'group_events_immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END
$$;
REVOKE ALL ON FUNCTION private.guard_group_events() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER group_events_guard
  BEFORE UPDATE OR DELETE ON public.group_events
  FOR EACH ROW EXECUTE FUNCTION private.guard_group_events();

-- The only writer (condition 8).
CREATE FUNCTION private.record_group_event(
  p_group_id uuid, p_actor_id uuid, p_kind text, p_subject_id uuid, p_subject_user_id uuid,
  p_people uuid[], p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  INSERT INTO public.group_events (group_id, actor_id, kind, subject_id, subject_user_id, people, payload)
  VALUES (p_group_id, p_actor_id, p_kind, p_subject_id, p_subject_user_id,
          ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_people, '{}') || ARRAY[p_actor_id, p_subject_user_id]) AS x
                 WHERE x IS NOT NULL ORDER BY x),
          jsonb_build_object('v', 1) || coalesce(p_payload, '{}'::jsonb))
$$;
REVOKE ALL ON FUNCTION private.record_group_event(uuid, uuid, text, uuid, uuid, uuid[], jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

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

CREATE OR REPLACE FUNCTION public.delete_expense(p_expense_id uuid, p_expected_updated_at timestamp with time zone) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_expense public.expenses;
  v_participants uuid[];
BEGIN
  v_expense := private.lock_expense_for_management(p_expense_id, p_expected_updated_at);
  SELECT array_agg(s.user_id ORDER BY s.user_id) INTO v_participants
    FROM public.expense_splits s WHERE s.expense_id = v_expense.id;
  PERFORM private.record_group_event(v_expense.group_id, auth.uid(), 'expense_deleted', v_expense.id, NULL,
    v_participants || v_expense.paid_by || v_expense.created_by,
    jsonb_build_object('amount_cents', v_expense.amount_cents, 'expense_date', v_expense.expense_date,
                       'paid_by', v_expense.paid_by, 'created_by', v_expense.created_by,
                       'participants', to_jsonb(v_participants)));
  -- Splits cascade with their expense; the balance check skips expenses
  -- deleted in the same transaction.
  DELETE FROM public.expenses WHERE id = v_expense.id;
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

CREATE OR REPLACE FUNCTION private.handle_new_group() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (NEW.id, NEW.created_by, 'owner');
  PERFORM private.record_group_event(NEW.id, NEW.created_by, 'group_created', NEW.id, NULL, NULL);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION private.admin_release_ownership(p_user_id uuid) RETURNS TABLE(group_id uuid, new_owner_id uuid)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_group uuid;
  v_successor uuid;
BEGIN
  FOR v_group IN
    SELECT gm.group_id FROM public.group_members gm
     WHERE gm.user_id = p_user_id AND gm.role = 'owner' AND gm.left_at IS NULL
     ORDER BY gm.group_id
  LOOP
    -- Lock the group's active memberships, then choose under the lock.
    PERFORM 1 FROM public.group_members gm
     WHERE gm.group_id = v_group AND gm.left_at IS NULL
     ORDER BY gm.user_id
     FOR UPDATE;

    SELECT gm.user_id INTO v_successor
      FROM public.group_members gm
      JOIN public.profiles p ON p.id = gm.user_id
     WHERE gm.group_id = v_group AND gm.user_id <> p_user_id
       AND gm.left_at IS NULL AND p.deleted_at IS NULL
     ORDER BY gm.joined_at, gm.user_id
     LIMIT 1;

    IF v_successor IS NULL THEN
      CONTINUE;  -- sole-member group: nothing to release
    END IF;

    UPDATE public.group_members SET role = 'member'
     WHERE group_members.group_id = v_group AND user_id = p_user_id;
    UPDATE public.group_members SET role = 'owner'
     WHERE group_members.group_id = v_group AND user_id = v_successor;
    PERFORM private.record_group_event(v_group, NULL, 'ownership_transferred', NULL, v_successor,
      ARRAY[p_user_id, v_successor], jsonb_build_object('from', p_user_id, 'to', v_successor, 'operator_release', true));

    group_id := v_group;
    new_owner_id := v_successor;
    RETURN NEXT;
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text)
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

  -- Serialise with the account-deletion trigger and other membership changes
  -- on this group, then re-check ownership under the lock: the owner may
  -- have deleted their account while this call waited (QS-B3-1). Done
  -- BEFORE the attempt is recorded, so every not_found_or_forbidden exit
  -- precedes the counted insert and no counted attempt is ever rolled back
  -- (CA-1). Do not move this below the rate-limit block.
  PERFORM 1 FROM public.groups g WHERE g.id = target_group_id FOR UPDATE;
  IF NOT private.is_active_owner_of(target_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
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
    PERFORM private.record_group_event(target_group_id, v_uid, 'member_rejoined', NULL, v_target, NULL);
  ELSE
    BEGIN
      INSERT INTO public.group_members (group_id, user_id, role)
      VALUES (target_group_id, v_target, 'member');
      PERFORM private.record_group_event(target_group_id, v_uid, 'member_added', NULL, v_target, NULL);
    EXCEPTION WHEN unique_violation THEN
      RETURN QUERY SELECT 'already_member'::text, NULL::uuid, NULL::text, NULL::text;
      RETURN;
    END;
  END IF;

  RETURN QUERY SELECT 'added'::text, v_target, v_name, 'member'::text;
END
$$;

CREATE OR REPLACE FUNCTION private.handle_auth_user_deleting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Lock every group this user actively owns (stable order), so the check
  -- below cannot interleave with a concurrent add-member, and a member added
  -- just before is seen (QS-B3-1).
  PERFORM 1 FROM public.groups g
   WHERE g.id IN (SELECT gm.group_id FROM public.group_members gm
                   WHERE gm.user_id = OLD.id AND gm.role = 'owner' AND gm.left_at IS NULL)
   ORDER BY g.id
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM public.group_members own
     WHERE own.user_id = OLD.id AND own.role = 'owner' AND own.left_at IS NULL
       AND EXISTS (SELECT 1 FROM public.group_members other
                    WHERE other.group_id = own.group_id AND other.user_id <> OLD.id
                      AND other.left_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'owner_must_transfer'
      USING ERRCODE = 'P0001',
            DETAIL = 'Transfer ownership of every shared group before deleting this account.';
  END IF;


  -- One event per group the account leaves (recorded before the update so
  -- the former role is known); actor NULL = account deletion.
  PERFORM private.record_group_event(gm.group_id, NULL, 'member_account_deleted', NULL, OLD.id, NULL,
            jsonb_build_object('was_owner', gm.role = 'owner'))
     FROM public.group_members gm
    WHERE gm.user_id = OLD.id AND gm.left_at IS NULL;
  UPDATE public.group_members
     SET role = 'member', left_at = now(), left_reason = 'account_deleted', removed_by = NULL
   WHERE user_id = OLD.id AND left_at IS NULL;

  UPDATE public.profiles
     SET full_name = 'Deleted user', avatar_url = NULL, deleted_at = now()
   WHERE id = OLD.id;

  RETURN OLD;
END
$$;

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

-- Backfill (condition 10): insert-only, marked backfilled, idempotent.
INSERT INTO public.group_events (group_id, actor_id, kind, subject_id, people, payload, backfilled, created_at)
SELECT g.id, p.id, 'group_created', g.id, ARRAY[g.created_by], '{"v": 1}'::jsonb, true, g.created_at
  FROM public.groups g
  LEFT JOIN public.profiles p ON p.id = g.created_by
 WHERE NOT EXISTS (SELECT 1 FROM public.group_events ev
                    WHERE ev.backfilled AND ev.kind = 'group_created' AND ev.group_id = g.id);

INSERT INTO public.group_events (group_id, actor_id, kind, subject_user_id, people, payload, backfilled, created_at)
SELECT gm.group_id, NULL, 'member_added', gm.user_id, ARRAY[gm.user_id], '{"v": 1}'::jsonb, true, gm.joined_at
  FROM public.group_members gm
  JOIN public.groups g ON g.id = gm.group_id
 WHERE gm.user_id <> g.created_by  -- the creator's founding membership is covered by group_created
   AND NOT EXISTS (SELECT 1 FROM public.group_events ev
                    WHERE ev.backfilled AND ev.kind = 'member_added'
                      AND ev.group_id = gm.group_id AND ev.subject_user_id = gm.user_id);

INSERT INTO public.group_events (group_id, actor_id, kind, subject_user_id, people, payload, backfilled, created_at)
SELECT gm.group_id,
       CASE gm.left_reason WHEN 'left' THEN gm.user_id WHEN 'removed' THEN gm.removed_by END,
       CASE gm.left_reason WHEN 'left' THEN 'member_left' WHEN 'removed' THEN 'member_removed'
                           ELSE 'member_account_deleted' END,
       gm.user_id,
       ARRAY(SELECT x FROM unnest(ARRAY[gm.user_id, gm.removed_by]) AS x WHERE x IS NOT NULL),
       '{"v": 1}'::jsonb, true, gm.left_at
  FROM public.group_members gm
 WHERE gm.left_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.group_events ev
                    WHERE ev.backfilled AND ev.kind IN ('member_left', 'member_removed', 'member_account_deleted')
                      AND ev.group_id = gm.group_id AND ev.subject_user_id = gm.user_id);

INSERT INTO public.group_events (group_id, actor_id, kind, subject_id, people, payload, backfilled, created_at)
SELECT e.group_id, e.created_by, 'expense_created', e.id,
       ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[e.created_by, e.paid_by] || sp.participants) AS x ORDER BY x),
       jsonb_build_object('v', 1, 'amount_cents', e.amount_cents, 'expense_date', e.expense_date,
                          'paid_by', e.paid_by, 'participants', to_jsonb(sp.participants)),
       true, e.created_at
  FROM public.expenses e
  CROSS JOIN LATERAL (SELECT array_agg(s.user_id ORDER BY s.user_id) AS participants
                        FROM public.expense_splits s WHERE s.expense_id = e.id) sp
 WHERE NOT EXISTS (SELECT 1 FROM public.group_events ev
                    WHERE ev.backfilled AND ev.kind = 'expense_created' AND ev.subject_id = e.id);
