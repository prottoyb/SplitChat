SET LOCAL lock_timeout = '5s';

-- M19: Smart Expense candidates (ADR-0012, conditions 1-16).
--
--  - private.create_equal_split_expense_core(actor, ...): the body of
--    create_equal_split_expense_v2 with the caller made explicit and optional
--    provenance merged into the expense_created payload. v2 is now a thin
--    wrapper: signature, grants, error codes and their order, and payload are
--    unchanged. The core is private (no client EXECUTE) and never reads
--    auth.uid().
--  - public.expense_candidates: one proposed expense per chat message, drafted
--    by the sender's client (a deterministic interpreter; never trusted) and
--    decided by a person. Draft fields may be missing until approval. RLS:
--    active members read; clients have no write grant. A decided candidate is
--    immutable (guard trigger); rows go only with their group.
--  - propose/update/reject/approve RPCs. Manage rule (M13): the proposer while
--    an active member, or the active owner. Approval creates the expense
--    through the core in the same transaction; at most one expense per
--    candidate; a repeated approval returns the same expense id.
--  - Lock order in every candidate RPC: unlocked authorization check, group
--    FOR KEY SHARE, candidate FOR UPDATE, re-check, active memberships
--    FOR SHARE ordered by user_id, re-check (consistent with delete_group,
--    the account-deletion trigger and transfer_group_ownership).
--  - No new group_events kinds: the candidate row is the audit record and the
--    expense_created payload carries candidate_id, message_id, proposed_by.
--  - Realtime: expense_candidates joins supabase_realtime.
--
-- Rollback: remove the table from the publication, drop the RPCs, the
-- table, the guard, the core and the (id, group_id) constraint, and restore
-- create_equal_split_expense_v2 verbatim from M16. Once candidates exist in
-- production this discards them: fix-forward, and any rollback needs its own
-- approval.

-- The candidate's composite foreign key keeps a message and its candidate in
-- the same group.
ALTER TABLE public.group_messages ADD CONSTRAINT group_messages_id_group_key UNIQUE (id, group_id);

-- Canonical expense creation (condition 2, 3) ----------------------------------
CREATE FUNCTION private.create_equal_split_expense_core(
  p_actor uuid, p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date,
  p_paid_by uuid, p_participant_ids uuid[], p_notes text, p_event_extra jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_description text := btrim(coalesce(p_description, ''));
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_count integer;
  v_distinct integer;
  v_expense_id uuid;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_group_id IS NULL OR NOT private.is_active_member_of(p_group_id, p_actor) THEN
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
          p_paid_by, p_actor, 'equal', v_notes)
  RETURNING id INTO v_expense_id;

  INSERT INTO public.expense_splits (expense_id, user_id, share_amount, percentage)
  SELECT v_expense_id, s.user_id, (s.share_cents::numeric / 100)::numeric(12, 2), NULL
    FROM private.equal_split_cents(p_amount_cents, p_participant_ids) s;

  PERFORM private.record_group_event(p_group_id, p_actor, 'expense_created', v_expense_id, NULL,
    p_participant_ids || p_paid_by,
    jsonb_build_object('amount_cents', p_amount_cents, 'expense_date', p_expense_date, 'paid_by', p_paid_by,
                       'participants', (SELECT to_jsonb(array_agg(p ORDER BY p)) FROM unnest(p_participant_ids) AS p))
    || coalesce(p_event_extra, '{}'::jsonb));

  RETURN v_expense_id;
END
$$;
REVOKE ALL ON FUNCTION private.create_equal_split_expense_core(uuid, uuid, text, bigint, date, uuid, uuid[], text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_equal_split_expense_v2(p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;
  RETURN private.create_equal_split_expense_core(v_uid, p_group_id, p_description, p_amount_cents,
    p_expense_date, p_paid_by, p_participant_ids, p_notes, '{}'::jsonb);
END
$$;

-- Candidates (condition 4) -----------------------------------------------------
CREATE TABLE public.expense_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.groups (id) ON DELETE CASCADE,
  message_id bigint NOT NULL,
  proposed_by uuid NOT NULL REFERENCES public.profiles (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'proposed',
  source text NOT NULL,
  interpreter_version text NOT NULL,
  description text,
  amount_cents bigint,
  expense_date date,
  paid_by uuid,
  participant_ids uuid[],
  notes text,
  version integer NOT NULL DEFAULT 1,
  expense_id uuid,
  decided_by uuid REFERENCES public.profiles (id) ON DELETE RESTRICT,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles (id) ON DELETE RESTRICT,
  CONSTRAINT expense_candidates_message_key UNIQUE (message_id),
  CONSTRAINT expense_candidates_expense_key UNIQUE (expense_id),
  CONSTRAINT expense_candidates_message_fkey FOREIGN KEY (message_id, group_id)
    REFERENCES public.group_messages (id, group_id) ON DELETE CASCADE,
  CONSTRAINT expense_candidates_status_check CHECK (status IN ('proposed', 'approved', 'rejected')),
  CONSTRAINT expense_candidates_source_check CHECK (source IN ('command', 'natural', 'manual')),
  CONSTRAINT expense_candidates_interpreter_check CHECK (char_length(interpreter_version) BETWEEN 1 AND 32),
  CONSTRAINT expense_candidates_description_check
    CHECK (description IS NULL OR (char_length(description) BETWEEN 1 AND 120 AND description = btrim(description))),
  CONSTRAINT expense_candidates_amount_check CHECK (amount_cents IS NULL OR amount_cents BETWEEN 1 AND 999999999999),
  CONSTRAINT expense_candidates_date_check CHECK (expense_date IS NULL OR expense_date >= DATE '2000-01-01'),
  CONSTRAINT expense_candidates_participants_check
    CHECK (participant_ids IS NULL OR cardinality(participant_ids) BETWEEN 1 AND 200),
  CONSTRAINT expense_candidates_notes_check CHECK (notes IS NULL OR char_length(notes) <= 500),
  CONSTRAINT expense_candidates_version_check CHECK (version >= 1),
  CONSTRAINT expense_candidates_approved_check CHECK ((status = 'approved') = (expense_id IS NOT NULL)),
  CONSTRAINT expense_candidates_decided_check
    CHECK ((status = 'proposed') = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT expense_candidates_complete_check CHECK (
    status <> 'approved' OR (description IS NOT NULL AND amount_cents IS NOT NULL AND expense_date IS NOT NULL
                             AND paid_by IS NOT NULL AND participant_ids IS NOT NULL))
);
CREATE INDEX expense_candidates_group_idx ON public.expense_candidates (group_id, created_at DESC);

ALTER TABLE public.expense_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.expense_candidates FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.expense_candidates TO authenticated;
CREATE POLICY "Members can read expense candidates" ON public.expense_candidates
  FOR SELECT TO authenticated
  USING (group_id IN (SELECT private.my_active_group_ids()));

CREATE FUNCTION private.guard_expense_candidates() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = OLD.group_id) THEN
      RETURN OLD;  -- the group itself is being deleted (cascade)
    END IF;
    RAISE EXCEPTION 'expense_candidates_immutable' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'proposed' THEN
    RAISE EXCEPTION 'candidate_decided' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.group_id, NEW.message_id, NEW.proposed_by, NEW.source, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.group_id, OLD.message_id, OLD.proposed_by, OLD.source, OLD.created_at) THEN
    RAISE EXCEPTION 'expense_candidates_immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION private.guard_expense_candidates() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER expense_candidates_guard
  BEFORE UPDATE OR DELETE ON public.expense_candidates
  FOR EACH ROW EXECUTE FUNCTION private.guard_expense_candidates();

-- Draft validation shared by propose and update: every field may be missing;
-- a present field must be valid now. Returns the trimmed description/notes.
CREATE FUNCTION private.check_candidate_draft(
  p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date,
  p_paid_by uuid, p_participant_ids uuid[], p_notes text,
  OUT description text, OUT notes text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
  v_distinct integer;
BEGIN
  description := nullif(btrim(coalesce(p_description, '')), '');
  notes := nullif(btrim(coalesce(p_notes, '')), '');
  IF description IS NOT NULL AND char_length(description) > 120 THEN
    RAISE EXCEPTION 'invalid_description' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount_cents IS NOT NULL AND (p_amount_cents <= 0 OR p_amount_cents > 999999999999) THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = 'P0001';
  END IF;
  IF p_expense_date IS NOT NULL
     AND (p_expense_date < DATE '2000-01-01' OR p_expense_date > current_date + 366) THEN
    RAISE EXCEPTION 'invalid_date' USING ERRCODE = 'P0001';
  END IF;
  IF p_paid_by IS NOT NULL AND NOT private.is_active_member_of(p_group_id, p_paid_by) THEN
    RAISE EXCEPTION 'invalid_payer' USING ERRCODE = 'P0001';
  END IF;
  IF p_participant_ids IS NOT NULL THEN
    v_count := coalesce(cardinality(p_participant_ids), 0);
    SELECT count(DISTINCT p) INTO v_distinct FROM unnest(p_participant_ids) AS p WHERE p IS NOT NULL;
    IF v_count = 0 OR v_count > 200 OR v_distinct <> v_count
       OR EXISTS (SELECT 1 FROM unnest(p_participant_ids) AS p
                   WHERE NOT private.is_active_member_of(p_group_id, p)) THEN
      RAISE EXCEPTION 'invalid_participants' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF notes IS NOT NULL AND char_length(notes) > 500 THEN
    RAISE EXCEPTION 'invalid_notes' USING ERRCODE = 'P0001';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION private.check_candidate_draft(uuid, text, bigint, date, uuid, uuid[], text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Locks the given active memberships FOR SHARE in user_id order. PL/pgSQL
-- PERFORM runs the query to completion (a SQL function returning a scalar
-- would fetch, and so lock, only the first row).
CREATE FUNCTION private.share_lock_memberships(p_group_id uuid, p_user_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.group_members gm
   WHERE gm.group_id = p_group_id AND gm.user_id = ANY (p_user_ids) AND gm.left_at IS NULL
   ORDER BY gm.user_id
   FOR SHARE;
END
$$;
REVOKE ALL ON FUNCTION private.share_lock_memberships(uuid, uuid[]) FROM PUBLIC, anon, authenticated, service_role;

-- The M13 manage rule for a candidate: its proposer while an active member,
-- or the active owner.
CREATE FUNCTION private.can_manage_candidate(p_candidate public.expense_candidates, p_actor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.is_active_member_of(p_candidate.group_id, p_actor)
     AND (p_candidate.proposed_by = p_actor OR private.is_active_owner_of(p_candidate.group_id, p_actor))
$$;
REVOKE ALL ON FUNCTION private.can_manage_candidate(public.expense_candidates, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Loads a candidate for a decision: authorization, then the locks in order,
-- then status/version and the manage rule re-checked under them.
CREATE FUNCTION private.lock_candidate(p_id uuid, p_actor uuid) RETURNS public.expense_candidates
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_group uuid;
  v_candidate public.expense_candidates;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;
  SELECT c.group_id INTO v_group FROM public.expense_candidates c WHERE c.id = p_id;
  IF v_group IS NULL OR NOT private.is_active_member_of(v_group, p_actor) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM public.groups g WHERE g.id = v_group FOR KEY SHARE;
  SELECT * INTO v_candidate FROM public.expense_candidates c WHERE c.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_candidate;
END
$$;
REVOKE ALL ON FUNCTION private.lock_candidate(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.propose_expense_candidate(
  p_message_id bigint, p_source text, p_interpreter_version text,
  p_description text, p_amount_cents bigint, p_expense_date date,
  p_paid_by uuid, p_participant_ids uuid[], p_notes text DEFAULT NULL
) RETURNS public.expense_candidates
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_message public.group_messages;
  v_draft record;
  v_row public.expense_candidates;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_message FROM public.group_messages m WHERE m.id = p_message_id;
  IF NOT FOUND OR NOT private.is_active_member_of(v_message.group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF v_message.sender_id <> v_uid THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('command', 'natural', 'manual')
     OR p_interpreter_version IS NULL OR char_length(p_interpreter_version) NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'invalid_source' USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1 FROM public.groups g WHERE g.id = v_message.group_id FOR KEY SHARE;
  -- One candidate per message: a repeat returns the existing one.
  SELECT * INTO v_row FROM public.expense_candidates c WHERE c.message_id = p_message_id;
  IF FOUND THEN
    RETURN v_row;
  END IF;
  PERFORM private.share_lock_memberships(v_message.group_id, ARRAY[v_uid]);
  IF NOT private.is_active_member_of(v_message.group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_draft FROM private.check_candidate_draft(v_message.group_id, p_description, p_amount_cents,
    p_expense_date, p_paid_by, p_participant_ids, p_notes);

  INSERT INTO public.expense_candidates (group_id, message_id, proposed_by, source, interpreter_version,
    description, amount_cents, expense_date, paid_by, participant_ids, notes, updated_by)
  VALUES (v_message.group_id, p_message_id, v_uid, p_source, p_interpreter_version,
    v_draft.description, p_amount_cents, p_expense_date, p_paid_by, p_participant_ids, v_draft.notes, v_uid)
  ON CONFLICT (message_id) DO NOTHING
  RETURNING * INTO v_row;
  IF v_row.id IS NULL THEN  -- a concurrent propose for the same message won
    SELECT * INTO v_row FROM public.expense_candidates c WHERE c.message_id = p_message_id;
  END IF;
  RETURN v_row;
END
$$;

CREATE FUNCTION public.update_expense_candidate(
  p_id uuid, p_expected_version integer,
  p_description text, p_amount_cents bigint, p_expense_date date,
  p_paid_by uuid, p_participant_ids uuid[], p_notes text DEFAULT NULL
) RETURNS public.expense_candidates
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_candidate public.expense_candidates;
  v_draft record;
  v_row public.expense_candidates;
BEGIN
  v_candidate := private.lock_candidate(p_id, v_uid);
  IF v_candidate.status <> 'proposed' THEN
    RAISE EXCEPTION 'candidate_decided' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_version IS DISTINCT FROM v_candidate.version THEN
    RAISE EXCEPTION 'stale_candidate' USING ERRCODE = 'P0001';
  END IF;
  PERFORM private.share_lock_memberships(v_candidate.group_id, ARRAY[v_uid]);
  IF NOT private.is_active_member_of(v_candidate.group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF NOT private.can_manage_candidate(v_candidate, v_uid) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_draft FROM private.check_candidate_draft(v_candidate.group_id, p_description, p_amount_cents,
    p_expense_date, p_paid_by, p_participant_ids, p_notes);

  UPDATE public.expense_candidates c
     SET description = v_draft.description, amount_cents = p_amount_cents, expense_date = p_expense_date,
         paid_by = p_paid_by, participant_ids = p_participant_ids, notes = v_draft.notes,
         version = c.version + 1, updated_at = now(), updated_by = v_uid
   WHERE c.id = p_id
  RETURNING * INTO v_row;
  RETURN v_row;
END
$$;

CREATE FUNCTION public.reject_expense_candidate(p_id uuid, p_expected_version integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_candidate public.expense_candidates;
BEGIN
  v_candidate := private.lock_candidate(p_id, v_uid);
  PERFORM private.share_lock_memberships(v_candidate.group_id, ARRAY[v_uid]);
  IF NOT private.is_active_member_of(v_candidate.group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF NOT private.can_manage_candidate(v_candidate, v_uid) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF v_candidate.status = 'rejected' THEN
    RETURN;  -- already rejected
  END IF;
  IF v_candidate.status <> 'proposed' THEN
    RAISE EXCEPTION 'candidate_decided' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_version IS DISTINCT FROM v_candidate.version THEN
    RAISE EXCEPTION 'stale_candidate' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.expense_candidates c
     SET status = 'rejected', decided_by = v_uid, decided_at = now(),
         version = c.version + 1, updated_at = now(), updated_by = v_uid
   WHERE c.id = p_id;
END
$$;

CREATE FUNCTION public.approve_expense_candidate(p_id uuid, p_expected_version integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_candidate public.expense_candidates;
  v_expense_id uuid;
BEGIN
  v_candidate := private.lock_candidate(p_id, v_uid);

  IF v_candidate.status = 'approved' THEN
    PERFORM private.share_lock_memberships(v_candidate.group_id, ARRAY[v_uid]);
    IF NOT private.can_manage_candidate(v_candidate, v_uid) THEN
      RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001';
    END IF;
    RETURN v_candidate.expense_id;  -- a repeated approval: the same expense
  END IF;
  IF v_candidate.status = 'rejected' THEN
    RAISE EXCEPTION 'candidate_rejected' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_version IS DISTINCT FROM v_candidate.version THEN
    RAISE EXCEPTION 'stale_candidate' USING ERRCODE = 'P0001';
  END IF;

  -- Everyone the expense involves stays a member until this commits.
  PERFORM private.share_lock_memberships(v_candidate.group_id,
    ARRAY[v_uid] || coalesce(ARRAY[v_candidate.paid_by], '{}') || coalesce(v_candidate.participant_ids, '{}'));
  IF NOT private.is_active_member_of(v_candidate.group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF NOT private.can_manage_candidate(v_candidate, v_uid) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF v_candidate.description IS NULL OR v_candidate.amount_cents IS NULL OR v_candidate.expense_date IS NULL
     OR v_candidate.paid_by IS NULL OR v_candidate.participant_ids IS NULL THEN
    RAISE EXCEPTION 'candidate_incomplete' USING ERRCODE = 'P0001';
  END IF;

  v_expense_id := private.create_equal_split_expense_core(v_uid, v_candidate.group_id, v_candidate.description,
    v_candidate.amount_cents, v_candidate.expense_date, v_candidate.paid_by, v_candidate.participant_ids,
    v_candidate.notes,
    jsonb_build_object('candidate_id', v_candidate.id, 'message_id', v_candidate.message_id,
                       'proposed_by', v_candidate.proposed_by));

  UPDATE public.expense_candidates c
     SET status = 'approved', expense_id = v_expense_id, decided_by = v_uid, decided_at = now(),
         version = c.version + 1, updated_at = now(), updated_by = v_uid
   WHERE c.id = p_id;
  RETURN v_expense_id;
END
$$;

REVOKE ALL ON FUNCTION public.propose_expense_candidate(bigint, text, text, text, bigint, date, uuid, uuid[], text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_expense_candidate(uuid, integer, text, bigint, date, uuid, uuid[], text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reject_expense_candidate(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.approve_expense_candidate(uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.propose_expense_candidate(bigint, text, text, text, bigint, date, uuid, uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_expense_candidate(uuid, integer, text, bigint, date, uuid, uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_expense_candidate(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_expense_candidate(uuid, integer) TO authenticated;

-- Realtime (Postgres Changes).
ALTER PUBLICATION supabase_realtime ADD TABLE public.expense_candidates;
