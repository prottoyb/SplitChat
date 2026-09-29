--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: private; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA private;


ALTER SCHEMA private OWNER TO postgres;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--

CREATE SCHEMA public;


ALTER SCHEMA public OWNER TO pg_database_owner;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: pg_database_owner
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: admin_release_ownership(uuid); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.admin_release_ownership(p_user_id uuid) RETURNS TABLE(group_id uuid, new_owner_id uuid)
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


ALTER FUNCTION private.admin_release_ownership(p_user_id uuid) OWNER TO postgres;

--
-- Name: assert_expense_balanced(uuid); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.assert_expense_balanced(p_expense_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_amount numeric;
  v_split_count bigint;
  v_split_total numeric;
BEGIN
  SELECT e.amount INTO v_amount FROM public.expenses e WHERE e.id = p_expense_id;
  IF NOT FOUND THEN
    RETURN;  -- deleted in this transaction; its splits cascade with it
  END IF;

  SELECT count(*), coalesce(sum(s.share_amount), 0)
    INTO v_split_count, v_split_total
    FROM public.expense_splits s
   WHERE s.expense_id = p_expense_id;

  IF v_split_count = 0 OR v_split_total <> v_amount THEN
    RAISE EXCEPTION 'expense_unbalanced'
      USING ERRCODE = 'P0001',
            DETAIL = format('Expense %s: amount %s, %s split(s) totalling %s.',
                            p_expense_id, v_amount, v_split_count, v_split_total);
  END IF;
END
$$;


ALTER FUNCTION private.assert_expense_balanced(p_expense_id uuid) OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: expense_candidates; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.expense_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    message_id bigint NOT NULL,
    proposed_by uuid NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    source text NOT NULL,
    interpreter_version text NOT NULL,
    description text,
    amount_cents bigint,
    expense_date date,
    paid_by uuid,
    participant_ids uuid[],
    notes text,
    version integer DEFAULT 1 NOT NULL,
    expense_id uuid,
    decided_by uuid,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT expense_candidates_amount_check CHECK (((amount_cents IS NULL) OR ((amount_cents >= 1) AND (amount_cents <= '999999999999'::bigint)))),
    CONSTRAINT expense_candidates_approved_check CHECK (((status = 'approved'::text) = (expense_id IS NOT NULL))),
    CONSTRAINT expense_candidates_complete_check CHECK (((status <> 'approved'::text) OR ((description IS NOT NULL) AND (amount_cents IS NOT NULL) AND (expense_date IS NOT NULL) AND (paid_by IS NOT NULL) AND (participant_ids IS NOT NULL)))),
    CONSTRAINT expense_candidates_date_check CHECK (((expense_date IS NULL) OR (expense_date >= '2000-01-01'::date))),
    CONSTRAINT expense_candidates_decided_check CHECK ((((status = 'proposed'::text) = (decided_by IS NULL)) AND ((decided_by IS NULL) = (decided_at IS NULL)))),
    CONSTRAINT expense_candidates_description_check CHECK (((description IS NULL) OR (((char_length(description) >= 1) AND (char_length(description) <= 120)) AND (description = btrim(description))))),
    CONSTRAINT expense_candidates_interpreter_check CHECK (((char_length(interpreter_version) >= 1) AND (char_length(interpreter_version) <= 32))),
    CONSTRAINT expense_candidates_notes_check CHECK (((notes IS NULL) OR (char_length(notes) <= 500))),
    CONSTRAINT expense_candidates_participants_check CHECK (((participant_ids IS NULL) OR ((cardinality(participant_ids) >= 1) AND (cardinality(participant_ids) <= 200)))),
    CONSTRAINT expense_candidates_source_check CHECK ((source = ANY (ARRAY['command'::text, 'natural'::text, 'manual'::text]))),
    CONSTRAINT expense_candidates_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT expense_candidates_version_check CHECK ((version >= 1))
);


ALTER TABLE public.expense_candidates OWNER TO postgres;

--
-- Name: can_manage_candidate(public.expense_candidates, uuid); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.can_manage_candidate(p_candidate public.expense_candidates, p_actor uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT private.is_active_member_of(p_candidate.group_id, p_actor)
     AND (p_candidate.proposed_by = p_actor OR private.is_active_owner_of(p_candidate.group_id, p_actor))
$$;


ALTER FUNCTION private.can_manage_candidate(p_candidate public.expense_candidates, p_actor uuid) OWNER TO postgres;

--
-- Name: check_candidate_draft(uuid, text, bigint, date, uuid, uuid[], text); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.check_candidate_draft(p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text, OUT description text, OUT notes text) RETURNS record
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
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


ALTER FUNCTION private.check_candidate_draft(p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text, OUT description text, OUT notes text) OWNER TO postgres;

--
-- Name: check_expense_balanced(); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.check_expense_balanced() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF TG_TABLE_NAME = 'expenses' THEN
    PERFORM private.assert_expense_balanced(NEW.id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM private.assert_expense_balanced(OLD.expense_id);
  ELSE
    PERFORM private.assert_expense_balanced(NEW.expense_id);
  END IF;
  RETURN NULL;
END
$$;


ALTER FUNCTION private.check_expense_balanced() OWNER TO postgres;

--
-- Name: create_equal_split_expense_core(uuid, uuid, text, bigint, date, uuid, uuid[], text, jsonb); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.create_equal_split_expense_core(p_actor uuid, p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text, p_event_extra jsonb DEFAULT '{}'::jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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

  -- Hold everyone the expense involves as members until it commits (QA
  -- Phase 7 MEDIUM): the group row (key share, delete_group's order), then
  -- their memberships in user_id order, re-checked under the locks. A removal
  -- or leave that commits first makes this refuse; one that comes later waits.
  PERFORM 1 FROM public.groups g WHERE g.id = p_group_id FOR KEY SHARE;
  PERFORM private.share_lock_memberships(p_group_id, ARRAY[p_actor, p_paid_by] || p_participant_ids);
  IF NOT private.is_active_member_of(p_group_id, p_actor) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF NOT private.is_active_member_of(p_group_id, p_paid_by) THEN
    RAISE EXCEPTION 'invalid_payer' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_participant_ids) AS p WHERE NOT private.is_active_member_of(p_group_id, p)) THEN
    RAISE EXCEPTION 'invalid_participants' USING ERRCODE = 'P0001';
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


ALTER FUNCTION private.create_equal_split_expense_core(p_actor uuid, p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text, p_event_extra jsonb) OWNER TO postgres;

--
-- Name: equal_split_cents(bigint, uuid[]); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.equal_split_cents(p_total_cents bigint, p_participant_ids uuid[]) RETURNS TABLE(user_id uuid, share_cents bigint)
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO ''
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


ALTER FUNCTION private.equal_split_cents(p_total_cents bigint, p_participant_ids uuid[]) OWNER TO postgres;

--
-- Name: group_balances(uuid); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.group_balances(p_group_id uuid) RETURNS TABLE(user_id uuid, paid_cents bigint, owed_cents bigint, settled_out_cents bigint, settled_in_cents bigint, net_cents bigint)
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  WITH parts (uid, paid, owed, s_out, s_in) AS (
    SELECT e.paid_by, e.amount_cents, 0::bigint, 0::bigint, 0::bigint
      FROM public.expenses e WHERE e.group_id = p_group_id
    UNION ALL
    SELECT s.user_id, 0, s.share_cents, 0, 0
      FROM public.expense_splits s JOIN public.expenses e ON e.id = s.expense_id
     WHERE e.group_id = p_group_id
    UNION ALL
    SELECT st.from_user, 0, 0, st.amount_cents, 0
      FROM public.settlements st WHERE st.group_id = p_group_id AND st.voided_at IS NULL
    UNION ALL
    SELECT st.to_user, 0, 0, 0, st.amount_cents
      FROM public.settlements st WHERE st.group_id = p_group_id AND st.voided_at IS NULL
  )
  SELECT uid, sum(paid)::bigint, sum(owed)::bigint, sum(s_out)::bigint, sum(s_in)::bigint,
         (sum(paid) - sum(owed) + sum(s_out) - sum(s_in))::bigint
    FROM parts
   GROUP BY uid
  HAVING sum(paid) <> 0 OR sum(owed) <> 0 OR sum(s_out) <> 0 OR sum(s_in) <> 0
   ORDER BY uid
$$;


ALTER FUNCTION private.group_balances(p_group_id uuid) OWNER TO postgres;

--
-- Name: guard_expense_candidates(); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.guard_expense_candidates() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
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


ALTER FUNCTION private.guard_expense_candidates() OWNER TO postgres;

--
-- Name: guard_expense_immutables(); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.guard_expense_immutables() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'immutable_field'
      USING ERRCODE = 'P0001',
            DETAIL = 'expenses.id, group_id, created_by and created_at cannot be changed.';
  END IF;
  RETURN NEW;
END
$$;


ALTER FUNCTION private.guard_expense_immutables() OWNER TO postgres;

--
-- Name: guard_group_events(); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.guard_group_events() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
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


ALTER FUNCTION private.guard_group_events() OWNER TO postgres;

--
-- Name: guard_group_immutables(); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.guard_group_immutables() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'immutable_field'
      USING ERRCODE = 'P0001',
            DETAIL = 'groups.id, created_by and created_at cannot be changed.';
  END IF;
  RETURN NEW;
END
$$;


ALTER FUNCTION private.guard_group_immutables() OWNER TO postgres;

--
-- Name: guard_group_messages(); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.guard_group_messages() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = OLD.group_id) THEN
    RETURN OLD;  -- the group itself is being deleted (cascade)
  END IF;
  RAISE EXCEPTION 'group_messages_immutable' USING ERRCODE = 'P0001';
END
$$;


ALTER FUNCTION private.guard_group_messages() OWNER TO postgres;

--
-- Name: guard_ledger_membership(); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.guard_ledger_membership() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_group_id uuid;
  v_user_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'expenses' THEN
    IF TG_OP = 'UPDATE' AND NEW.paid_by IS NOT DISTINCT FROM OLD.paid_by THEN
      RETURN NEW;
    END IF;
    v_group_id := NEW.group_id;
    v_user_id := NEW.paid_by;
  ELSE
    SELECT e.group_id INTO v_group_id FROM public.expenses e WHERE e.id = NEW.expense_id;
    v_user_id := NEW.user_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.group_members gm
     WHERE gm.group_id = v_group_id AND gm.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'ledger_member_required'
      USING ERRCODE = 'P0001',
            DETAIL = 'Payers and split participants must be members of the expense''s group.';
  END IF;
  RETURN NEW;
END
$$;


ALTER FUNCTION private.guard_ledger_membership() OWNER TO postgres;

--
-- Name: guard_settlements(); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.guard_settlements() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL
     AND (NEW.id, NEW.group_id, NEW.from_user, NEW.to_user, NEW.amount_cents, NEW.settled_on,
          NEW.note, NEW.client_request_id, NEW.created_by, NEW.created_at)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.group_id, OLD.from_user, OLD.to_user, OLD.amount_cents, OLD.settled_on,
          OLD.note, OLD.client_request_id, OLD.created_by, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'settlements_immutable' USING ERRCODE = 'P0001';
END
$$;


ALTER FUNCTION private.guard_settlements() OWNER TO postgres;

--
-- Name: guard_split_immutables(); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.guard_split_immutables() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.expense_id IS DISTINCT FROM OLD.expense_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'immutable_field'
      USING ERRCODE = 'P0001',
            DETAIL = 'expense_splits.id, expense_id and user_id cannot be changed.';
  END IF;
  RETURN NEW;
END
$$;


ALTER FUNCTION private.guard_split_immutables() OWNER TO postgres;

--
-- Name: handle_auth_user_deleting(); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.handle_auth_user_deleting() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


ALTER FUNCTION private.handle_auth_user_deleting() OWNER TO postgres;

--
-- Name: handle_new_group(); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.handle_new_group() RETURNS trigger
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


ALTER FUNCTION private.handle_new_group() OWNER TO postgres;

--
-- Name: handle_new_user(); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_name text := btrim(left(btrim(coalesce(NEW.raw_user_meta_data ->> 'full_name', '')), 80));
BEGIN
  IF v_name = '' OR lower(regexp_replace(v_name, '\s+', ' ', 'g')) = 'deleted user' THEN
    v_name := btrim(left(split_part(coalesce(NEW.email, ''), '@', 1), 80));
  END IF;
  IF v_name = '' THEN
    v_name := 'SplitChat member';
  END IF;
  INSERT INTO public.profiles (id, full_name)
  VALUES (NEW.id, v_name)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END
$$;


ALTER FUNCTION private.handle_new_user() OWNER TO postgres;

--
-- Name: is_active_member_of(uuid, uuid); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.is_active_member_of(p_group_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members gm
     WHERE gm.group_id = p_group_id AND gm.user_id = p_user_id AND gm.left_at IS NULL
  )
$$;


ALTER FUNCTION private.is_active_member_of(p_group_id uuid, p_user_id uuid) OWNER TO postgres;

--
-- Name: is_active_owner_of(uuid, uuid); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.is_active_owner_of(p_group_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members gm
     WHERE gm.group_id = p_group_id AND gm.user_id = p_user_id
       AND gm.role = 'owner' AND gm.left_at IS NULL
  )
$$;


ALTER FUNCTION private.is_active_owner_of(p_group_id uuid, p_user_id uuid) OWNER TO postgres;

--
-- Name: lock_candidate(uuid, uuid); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.lock_candidate(p_id uuid, p_actor uuid) RETURNS public.expense_candidates
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


ALTER FUNCTION private.lock_candidate(p_id uuid, p_actor uuid) OWNER TO postgres;

--
-- Name: expenses; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    description text NOT NULL,
    amount numeric(12,2) NOT NULL,
    expense_date date DEFAULT CURRENT_DATE NOT NULL,
    paid_by uuid NOT NULL,
    created_by uuid DEFAULT auth.uid() NOT NULL,
    split_type text DEFAULT 'equal'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    amount_cents bigint GENERATED ALWAYS AS (((amount * (100)::numeric))::bigint) STORED,
    updated_by uuid,
    CONSTRAINT expenses_amount_positive_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT expenses_description_length_check CHECK (((char_length(btrim(description)) >= 1) AND (char_length(btrim(description)) <= 120))),
    CONSTRAINT expenses_notes_length_check CHECK (((notes IS NULL) OR (char_length(notes) <= 500))),
    CONSTRAINT expenses_split_type_check CHECK ((split_type = 'equal'::text))
);


ALTER TABLE public.expenses OWNER TO postgres;

--
-- Name: lock_expense_for_management(uuid, timestamp with time zone); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.lock_expense_for_management(p_expense_id uuid, p_expected_updated_at timestamp with time zone) RETURNS public.expenses
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


ALTER FUNCTION private.lock_expense_for_management(p_expense_id uuid, p_expected_updated_at timestamp with time zone) OWNER TO postgres;

--
-- Name: my_active_group_ids(); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.my_active_group_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT gm.group_id FROM public.group_members gm
   WHERE gm.user_id = (SELECT auth.uid()) AND gm.left_at IS NULL
$$;


ALTER FUNCTION private.my_active_group_ids() OWNER TO postgres;

--
-- Name: my_group_peer_ids(); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.my_group_peer_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT DISTINCT peer.user_id
    FROM public.group_members me
    JOIN public.group_members peer ON peer.group_id = me.group_id
   WHERE me.user_id = (SELECT auth.uid()) AND me.left_at IS NULL AND peer.left_at IS NULL
$$;


ALTER FUNCTION private.my_group_peer_ids() OWNER TO postgres;

--
-- Name: record_group_event(uuid, uuid, text, uuid, uuid, uuid[], jsonb); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.record_group_event(p_group_id uuid, p_actor_id uuid, p_kind text, p_subject_id uuid, p_subject_user_id uuid, p_people uuid[], p_payload jsonb DEFAULT '{}'::jsonb) RETURNS void
    LANGUAGE sql
    SET search_path TO ''
    AS $$
  INSERT INTO public.group_events (group_id, actor_id, kind, subject_id, subject_user_id, people, payload)
  VALUES (p_group_id, p_actor_id, p_kind, p_subject_id, p_subject_user_id,
          ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_people, '{}') || ARRAY[p_actor_id, p_subject_user_id]) AS x
                 WHERE x IS NOT NULL ORDER BY x),
          jsonb_build_object('v', 1) || coalesce(p_payload, '{}'::jsonb))
$$;


ALTER FUNCTION private.record_group_event(p_group_id uuid, p_actor_id uuid, p_kind text, p_subject_id uuid, p_subject_user_id uuid, p_people uuid[], p_payload jsonb) OWNER TO postgres;

--
-- Name: set_updated_at(); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;


ALTER FUNCTION private.set_updated_at() OWNER TO postgres;

--
-- Name: share_lock_memberships(uuid, uuid[]); Type: FUNCTION; Schema: private; Owner: postgres
--

CREATE FUNCTION private.share_lock_memberships(p_group_id uuid, p_user_ids uuid[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  PERFORM 1 FROM public.group_members gm
   WHERE gm.group_id = p_group_id AND gm.user_id = ANY (p_user_ids) AND gm.left_at IS NULL
   ORDER BY gm.user_id
   FOR SHARE;
END
$$;


ALTER FUNCTION private.share_lock_memberships(p_group_id uuid, p_user_ids uuid[]) OWNER TO postgres;

--
-- Name: add_group_member_by_email(uuid, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text) RETURNS TABLE(result text, added_user_id uuid, added_full_name text, added_role text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
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
$_$;


ALTER FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text) OWNER TO postgres;

--
-- Name: approve_expense_candidate(uuid, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.approve_expense_candidate(p_id uuid, p_expected_version integer) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


ALTER FUNCTION public.approve_expense_candidate(p_id uuid, p_expected_version integer) OWNER TO postgres;

--
-- Name: create_equal_split_expense_v2(uuid, text, bigint, date, uuid, uuid[], text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_equal_split_expense_v2(p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text DEFAULT NULL::text) RETURNS uuid
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


ALTER FUNCTION public.create_equal_split_expense_v2(p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) OWNER TO postgres;

--
-- Name: delete_expense(uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.delete_expense(p_expense_id uuid, p_expected_updated_at timestamp with time zone) RETURNS void
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


ALTER FUNCTION public.delete_expense(p_expense_id uuid, p_expected_updated_at timestamp with time zone) OWNER TO postgres;

--
-- Name: delete_group(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.delete_group(p_group_id uuid) RETURNS void
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
                 WHERE e.group_id = p_group_id AND s.user_id <> v_uid)
     -- M17: a settlement always names a second member, so a group that passed
     -- the check above has none; this is a backstop.
     OR EXISTS (SELECT 1 FROM public.settlements st WHERE st.group_id = p_group_id) THEN
    RAISE EXCEPTION 'group_has_shared_history' USING ERRCODE = 'P0001';
  END IF;

  -- Splits cascade with their expenses; the deferred balance check skips
  -- expenses deleted in the same transaction.
  DELETE FROM public.expenses WHERE group_id = p_group_id;
  DELETE FROM public.group_members WHERE group_id = p_group_id;
  DELETE FROM public.groups WHERE id = p_group_id;
END
$$;


ALTER FUNCTION public.delete_group(p_group_id uuid) OWNER TO postgres;

--
-- Name: get_group_balances(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.get_group_balances(p_group_id uuid) RETURNS TABLE(user_id uuid, paid_cents bigint, owed_cents bigint, settled_out_cents bigint, settled_in_cents bigint, net_cents bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_group_id IS NULL OR NOT private.is_active_member_of(p_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT * FROM private.group_balances(p_group_id);
END
$$;


ALTER FUNCTION public.get_group_balances(p_group_id uuid) OWNER TO postgres;

--
-- Name: get_ledger_identities(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.get_ledger_identities(p_group_id uuid) RETURNS TABLE(user_id uuid, display_name text)
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
    UNION
    -- Chat senders (M18): a message references its sender like a ledger row.
    -- Probed per member (sender index), so the cost is O(members).
    SELECT gm.user_id FROM public.group_members gm
     WHERE gm.group_id = p_group_id
       AND EXISTS (SELECT 1 FROM public.group_messages m
                    WHERE m.sender_id = gm.user_id AND m.group_id = p_group_id)
  )
  SELECT r.uid, coalesce(nullif(btrim(p.full_name), ''), 'SplitChat member')
    FROM referenced r
    LEFT JOIN public.profiles p ON p.id = r.uid
   WHERE NOT private.is_active_member_of(p_group_id, r.uid);
END
$$;


ALTER FUNCTION public.get_ledger_identities(p_group_id uuid) OWNER TO postgres;

--
-- Name: leave_group(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.leave_group(p_group_id uuid) RETURNS void
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


ALTER FUNCTION public.leave_group(p_group_id uuid) OWNER TO postgres;

--
-- Name: propose_expense_candidate(bigint, text, text, text, bigint, date, uuid, uuid[], text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.propose_expense_candidate(p_message_id bigint, p_source text, p_interpreter_version text, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text DEFAULT NULL::text) RETURNS public.expense_candidates
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


ALTER FUNCTION public.propose_expense_candidate(p_message_id bigint, p_source text, p_interpreter_version text, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) OWNER TO postgres;

--
-- Name: record_settlement(uuid, uuid, uuid, bigint, date, text, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.record_settlement(p_group_id uuid, p_from_user uuid, p_to_user uuid, p_amount_cents bigint, p_settled_on date, p_note text DEFAULT NULL::text, p_client_request_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_existing public.settlements;
  v_from_net bigint;
  v_to_net bigint;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;
  -- Unlocked check first, so an outsider can never take or wait on the lock.
  IF p_group_id IS NULL OR NOT private.is_active_member_of(p_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF p_from_user IS NULL OR p_to_user IS NULL OR p_from_user = p_to_user
     OR NOT EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = p_group_id AND gm.user_id = p_from_user)
     OR NOT EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = p_group_id AND gm.user_id = p_to_user) THEN
    RAISE EXCEPTION 'invalid_parties' USING ERRCODE = 'P0001';
  END IF;
  IF v_uid <> p_from_user AND v_uid <> p_to_user AND NOT private.is_active_owner_of(p_group_id, v_uid) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 999999999999 THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = 'P0001';
  END IF;
  IF p_settled_on IS NULL OR p_settled_on < DATE '2000-01-01' OR p_settled_on > current_date + 366 THEN
    RAISE EXCEPTION 'invalid_date' USING ERRCODE = 'P0001';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 200 THEN
    RAISE EXCEPTION 'invalid_note' USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1 FROM public.groups g WHERE g.id = p_group_id FOR UPDATE;
  -- Re-check under the lock (membership or ownership may have changed).
  IF NOT private.is_active_member_of(p_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF v_uid <> p_from_user AND v_uid <> p_to_user AND NOT private.is_active_owner_of(p_group_id, v_uid) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001';
  END IF;

  -- Idempotent retry: the same request id returns the settlement it made.
  IF p_client_request_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.settlements s
     WHERE s.group_id = p_group_id AND s.created_by = v_uid AND s.client_request_id = p_client_request_id;
    IF FOUND THEN
      IF (v_existing.from_user, v_existing.to_user, v_existing.amount_cents, v_existing.settled_on, v_existing.note)
         IS NOT DISTINCT FROM (p_from_user, p_to_user, p_amount_cents, p_settled_on, v_note) THEN
        RETURN v_existing.id;
      END IF;
      RAISE EXCEPTION 'duplicate_request' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  SELECT coalesce(max(b.net_cents) FILTER (WHERE b.user_id = p_from_user), 0),
         coalesce(max(b.net_cents) FILTER (WHERE b.user_id = p_to_user), 0)
    INTO v_from_net, v_to_net
    FROM private.group_balances(p_group_id) b;
  IF v_from_net >= 0 OR v_to_net <= 0 THEN
    RAISE EXCEPTION 'nothing_to_settle' USING ERRCODE = 'P0001';
  END IF;
  IF p_amount_cents > least(-v_from_net, v_to_net) THEN
    RAISE EXCEPTION 'exceeds_balance' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.settlements (group_id, from_user, to_user, amount_cents, settled_on, note, client_request_id, created_by)
  VALUES (p_group_id, p_from_user, p_to_user, p_amount_cents, p_settled_on, v_note, p_client_request_id, v_uid)
  RETURNING id INTO v_id;

  PERFORM private.record_group_event(p_group_id, v_uid, 'settlement_recorded', v_id, NULL,
    ARRAY[p_from_user, p_to_user],
    jsonb_build_object('amount_cents', p_amount_cents, 'settled_on', p_settled_on,
                       'from_user', p_from_user, 'to_user', p_to_user));
  RETURN v_id;
END
$$;


ALTER FUNCTION public.record_settlement(p_group_id uuid, p_from_user uuid, p_to_user uuid, p_amount_cents bigint, p_settled_on date, p_note text, p_client_request_id uuid) OWNER TO postgres;

--
-- Name: reject_expense_candidate(uuid, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.reject_expense_candidate(p_id uuid, p_expected_version integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


ALTER FUNCTION public.reject_expense_candidate(p_id uuid, p_expected_version integer) OWNER TO postgres;

--
-- Name: remove_group_member(uuid, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.remove_group_member(p_group_id uuid, p_user_id uuid) RETURNS void
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


ALTER FUNCTION public.remove_group_member(p_group_id uuid, p_user_id uuid) OWNER TO postgres;

--
-- Name: group_messages; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.group_messages (
    id bigint NOT NULL,
    group_id uuid NOT NULL,
    sender_id uuid NOT NULL,
    body text NOT NULL,
    client_request_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT group_messages_body_check CHECK ((((char_length(body) >= 1) AND (char_length(body) <= 2000)) AND (body = btrim(body, ' 	
'::text)) AND (body !~ '[\x01-\x08\x0B-\x1F\x7F]'::text)))
);


ALTER TABLE public.group_messages OWNER TO postgres;

--
-- Name: send_group_message(uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.send_group_message(p_group_id uuid, p_body text, p_client_request_id uuid) RETURNS public.group_messages
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_body text;
  v_existing public.group_messages;
  v_row public.group_messages;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_group_id IS NULL OR NOT private.is_active_member_of(p_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;

  v_body := btrim(coalesce(p_body, ''), E' \t\n\r');
  IF char_length(v_body) NOT BETWEEN 1 AND 2000 OR v_body ~ '[\x01-\x08\x0B-\x1F\x7F]' THEN
    RAISE EXCEPTION 'invalid_body' USING ERRCODE = 'P0001';
  END IF;
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'invalid_request' USING ERRCODE = 'P0001';
  END IF;

  -- Lock order as delete_group (group row, then memberships): the insert's
  -- foreign key needs a key-share lock on the group anyway, taken first here
  -- so the two can never deadlock.
  PERFORM 1 FROM public.groups g WHERE g.id = p_group_id FOR KEY SHARE;
  -- Hold the caller's membership: a concurrent leave, removal or account
  -- deletion waits for this send, or this send waits and then is refused.
  PERFORM 1 FROM public.group_members gm
    WHERE gm.group_id = p_group_id AND gm.user_id = v_uid AND gm.left_at IS NULL
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;

  -- One send per sender at a time, so the rate-limit count cannot race.
  PERFORM pg_advisory_xact_lock(hashtextextended('splitchat.group_messages:' || v_uid::text, 0));

  SELECT * INTO v_existing FROM public.group_messages m
   WHERE m.group_id = p_group_id AND m.sender_id = v_uid AND m.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.body = v_body THEN
      RETURN v_existing;  -- a retry of a message already sent
    END IF;
    RAISE EXCEPTION 'duplicate_request' USING ERRCODE = 'P0001';
  END IF;

  IF (SELECT count(*) FROM public.group_messages m
       WHERE m.sender_id = v_uid AND m.created_at > clock_timestamp() - interval '60 seconds') >= 20
     OR (SELECT count(*) FROM public.group_messages m
          WHERE m.sender_id = v_uid AND m.created_at > clock_timestamp() - interval '1 day') >= 1000 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.group_messages (group_id, sender_id, body, client_request_id, created_at)
  VALUES (p_group_id, v_uid, v_body, p_client_request_id, clock_timestamp())
  RETURNING * INTO v_row;
  RETURN v_row;
END
$$;


ALTER FUNCTION public.send_group_message(p_group_id uuid, p_body text, p_client_request_id uuid) OWNER TO postgres;

--
-- Name: transfer_group_ownership(uuid, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.transfer_group_ownership(p_group_id uuid, p_new_owner_id uuid) RETURNS void
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


ALTER FUNCTION public.transfer_group_ownership(p_group_id uuid, p_new_owner_id uuid) OWNER TO postgres;

--
-- Name: update_equal_split_expense(uuid, timestamp with time zone, text, bigint, date, uuid, uuid[], text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_equal_split_expense(p_expense_id uuid, p_expected_updated_at timestamp with time zone, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text DEFAULT NULL::text) RETURNS timestamp with time zone
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


ALTER FUNCTION public.update_equal_split_expense(p_expense_id uuid, p_expected_updated_at timestamp with time zone, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) OWNER TO postgres;

--
-- Name: update_expense_candidate(uuid, integer, text, bigint, date, uuid, uuid[], text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_expense_candidate(p_id uuid, p_expected_version integer, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text DEFAULT NULL::text) RETURNS public.expense_candidates
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


ALTER FUNCTION public.update_expense_candidate(p_id uuid, p_expected_version integer, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) OWNER TO postgres;

--
-- Name: update_group_details(uuid, text, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_group_details(p_group_id uuid, p_name text, p_description text, p_expected_updated_at timestamp with time zone) RETURNS timestamp with time zone
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
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


ALTER FUNCTION public.update_group_details(p_group_id uuid, p_name text, p_description text, p_expected_updated_at timestamp with time zone) OWNER TO postgres;

--
-- Name: void_settlement(uuid, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.void_settlement(p_settlement_id uuid, p_reason text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_group_id uuid;
  v_settlement public.settlements;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth_required' USING ERRCODE = 'P0001';
  END IF;
  SELECT s.group_id INTO v_group_id FROM public.settlements s WHERE s.id = p_settlement_id;
  IF v_group_id IS NULL OR NOT private.is_active_member_of(v_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 200 THEN
    RAISE EXCEPTION 'invalid_reason' USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1 FROM public.groups g WHERE g.id = v_group_id FOR UPDATE;
  SELECT * INTO v_settlement FROM public.settlements s WHERE s.id = p_settlement_id FOR UPDATE;
  IF NOT private.is_active_member_of(v_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF v_uid <> v_settlement.from_user AND v_uid <> v_settlement.to_user
     AND NOT private.is_active_owner_of(v_group_id, v_uid) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF v_settlement.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'already_voided' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.settlements
     SET voided_at = now(), voided_by = v_uid, void_reason = v_reason
   WHERE id = v_settlement.id;

  PERFORM private.record_group_event(v_group_id, v_uid, 'settlement_voided', v_settlement.id, NULL,
    ARRAY[v_settlement.from_user, v_settlement.to_user],
    jsonb_build_object('amount_cents', v_settlement.amount_cents, 'settled_on', v_settlement.settled_on,
                       'from_user', v_settlement.from_user, 'to_user', v_settlement.to_user));
END
$$;


ALTER FUNCTION public.void_settlement(p_settlement_id uuid, p_reason text) OWNER TO postgres;

--
-- Name: member_add_attempts; Type: TABLE; Schema: private; Owner: postgres
--

CREATE TABLE private.member_add_attempts (
    id bigint NOT NULL,
    caller_id uuid NOT NULL,
    group_id uuid NOT NULL,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE private.member_add_attempts OWNER TO postgres;

--
-- Name: member_add_attempts_id_seq; Type: SEQUENCE; Schema: private; Owner: postgres
--

ALTER TABLE private.member_add_attempts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME private.member_add_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: expense_splits; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.expense_splits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    expense_id uuid NOT NULL,
    user_id uuid NOT NULL,
    share_amount numeric(12,2) NOT NULL,
    percentage numeric(7,4),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    share_cents bigint GENERATED ALWAYS AS (((share_amount * (100)::numeric))::bigint) STORED,
    CONSTRAINT expense_splits_percentage_check CHECK (((percentage IS NULL) OR ((percentage >= (0)::numeric) AND (percentage <= (100)::numeric)))),
    CONSTRAINT expense_splits_share_amount_check CHECK ((share_amount >= (0)::numeric))
);


ALTER TABLE public.expense_splits OWNER TO postgres;

--
-- Name: group_events; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.group_events (
    id bigint NOT NULL,
    group_id uuid NOT NULL,
    actor_id uuid,
    kind text NOT NULL,
    subject_id uuid,
    subject_user_id uuid,
    people uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    payload jsonb NOT NULL,
    backfilled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT group_events_kind_check CHECK ((kind = ANY (ARRAY['group_created'::text, 'member_added'::text, 'member_rejoined'::text, 'member_left'::text, 'member_removed'::text, 'member_account_deleted'::text, 'ownership_transferred'::text, 'expense_created'::text, 'expense_updated'::text, 'expense_deleted'::text, 'settlement_recorded'::text, 'settlement_voided'::text, 'group_updated'::text]))),
    CONSTRAINT group_events_payload_check CHECK (((jsonb_typeof(payload) = 'object'::text) AND (payload ? 'v'::text)))
);


ALTER TABLE public.group_events OWNER TO postgres;

--
-- Name: group_events_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.group_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.group_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: group_members; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.group_members (
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    left_at timestamp with time zone,
    left_reason text,
    removed_by uuid,
    CONSTRAINT group_members_left_consistency CHECK (((left_at IS NULL) = (left_reason IS NULL))),
    CONSTRAINT group_members_left_reason_check CHECK ((left_reason = ANY (ARRAY['left'::text, 'removed'::text, 'account_deleted'::text]))),
    CONSTRAINT group_members_owner_active CHECK (((role <> 'owner'::text) OR (left_at IS NULL))),
    CONSTRAINT group_members_removed_by_consistency CHECK (((removed_by IS NULL) OR (left_reason = 'removed'::text))),
    CONSTRAINT group_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'member'::text])))
);


ALTER TABLE public.group_members OWNER TO postgres;

--
-- Name: group_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

ALTER TABLE public.group_messages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.group_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: groups; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT groups_description_check CHECK (((description IS NULL) OR (char_length(description) <= 300))),
    CONSTRAINT groups_name_check CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 80)))
);


ALTER TABLE public.groups OWNER TO postgres;

--
-- Name: profiles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    full_name text DEFAULT ''::text NOT NULL,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


ALTER TABLE public.profiles OWNER TO postgres;

--
-- Name: settlements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.settlements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    from_user uuid NOT NULL,
    to_user uuid NOT NULL,
    amount_cents bigint NOT NULL,
    settled_on date NOT NULL,
    note text,
    client_request_id uuid,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    voided_at timestamp with time zone,
    voided_by uuid,
    void_reason text,
    CONSTRAINT settlements_amount_check CHECK (((amount_cents > 0) AND (amount_cents <= '999999999999'::bigint))),
    CONSTRAINT settlements_distinct_parties CHECK ((from_user <> to_user)),
    CONSTRAINT settlements_note_check CHECK (((note IS NULL) OR (((char_length(note) >= 1) AND (char_length(note) <= 200)) AND (note = btrim(note))))),
    CONSTRAINT settlements_settled_on_check CHECK ((settled_on >= '2000-01-01'::date)),
    CONSTRAINT settlements_void_consistency CHECK ((((voided_at IS NULL) = (voided_by IS NULL)) AND ((voided_at IS NULL) = (void_reason IS NULL)))),
    CONSTRAINT settlements_void_reason_check CHECK (((void_reason IS NULL) OR (((char_length(void_reason) >= 1) AND (char_length(void_reason) <= 200)) AND (void_reason = btrim(void_reason)))))
);


ALTER TABLE public.settlements OWNER TO postgres;

--
-- Name: member_add_attempts member_add_attempts_pkey; Type: CONSTRAINT; Schema: private; Owner: postgres
--

ALTER TABLE ONLY private.member_add_attempts
    ADD CONSTRAINT member_add_attempts_pkey PRIMARY KEY (id);


--
-- Name: expense_candidates expense_candidates_expense_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expense_candidates
    ADD CONSTRAINT expense_candidates_expense_key UNIQUE (expense_id);


--
-- Name: expense_candidates expense_candidates_message_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expense_candidates
    ADD CONSTRAINT expense_candidates_message_key UNIQUE (message_id);


--
-- Name: expense_candidates expense_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expense_candidates
    ADD CONSTRAINT expense_candidates_pkey PRIMARY KEY (id);


--
-- Name: expense_splits expense_splits_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expense_splits
    ADD CONSTRAINT expense_splits_pkey PRIMARY KEY (id);


--
-- Name: expense_splits expense_splits_unique_participant; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expense_splits
    ADD CONSTRAINT expense_splits_unique_participant UNIQUE (expense_id, user_id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: group_events group_events_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_events
    ADD CONSTRAINT group_events_pkey PRIMARY KEY (id);


--
-- Name: group_members group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_pkey PRIMARY KEY (group_id, user_id);


--
-- Name: group_messages group_messages_id_group_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_id_group_key UNIQUE (id, group_id);


--
-- Name: group_messages group_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_pkey PRIMARY KEY (id);


--
-- Name: group_messages group_messages_request_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_request_unique UNIQUE (group_id, sender_id, client_request_id);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_full_name_check; Type: CHECK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_full_name_check CHECK (((deleted_at IS NOT NULL) OR ((full_name = btrim(full_name)) AND ((char_length(full_name) >= 1) AND (char_length(full_name) <= 80)) AND (lower(regexp_replace(full_name, '\s+'::text, ' '::text, 'g'::text)) <> 'deleted user'::text)))) NOT VALID;


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: settlements settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_pkey PRIMARY KEY (id);


--
-- Name: settlements settlements_request_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_request_unique UNIQUE (group_id, created_by, client_request_id);


--
-- Name: member_add_attempts_caller_time_idx; Type: INDEX; Schema: private; Owner: postgres
--

CREATE INDEX member_add_attempts_caller_time_idx ON private.member_add_attempts USING btree (caller_id, attempted_at);


--
-- Name: expense_candidates_group_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX expense_candidates_group_idx ON public.expense_candidates USING btree (group_id, created_at DESC);


--
-- Name: expense_splits_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX expense_splits_user_id_idx ON public.expense_splits USING btree (user_id);


--
-- Name: expenses_created_by_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX expenses_created_by_idx ON public.expenses USING btree (created_by);


--
-- Name: expenses_expense_date_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX expenses_expense_date_idx ON public.expenses USING btree (expense_date DESC);


--
-- Name: expenses_group_date_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX expenses_group_date_idx ON public.expenses USING btree (group_id, expense_date DESC, created_at DESC);


--
-- Name: expenses_paid_by_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX expenses_paid_by_idx ON public.expenses USING btree (paid_by);


--
-- Name: group_events_group_created_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX group_events_group_created_idx ON public.group_events USING btree (group_id, created_at DESC, id DESC);


--
-- Name: group_members_one_active_owner; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX group_members_one_active_owner ON public.group_members USING btree (group_id) WHERE ((role = 'owner'::text) AND (left_at IS NULL));


--
-- Name: group_members_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX group_members_user_id_idx ON public.group_members USING btree (user_id);


--
-- Name: group_messages_group_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX group_messages_group_idx ON public.group_messages USING btree (group_id, created_at DESC, id DESC);


--
-- Name: group_messages_sender_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX group_messages_sender_idx ON public.group_messages USING btree (sender_id, created_at DESC);


--
-- Name: groups_created_by_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX groups_created_by_idx ON public.groups USING btree (created_by);


--
-- Name: settlements_from_user_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX settlements_from_user_idx ON public.settlements USING btree (from_user);


--
-- Name: settlements_group_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX settlements_group_idx ON public.settlements USING btree (group_id, settled_on DESC, created_at DESC);


--
-- Name: settlements_to_user_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX settlements_to_user_idx ON public.settlements USING btree (to_user);


--
-- Name: expense_candidates expense_candidates_guard; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER expense_candidates_guard BEFORE DELETE OR UPDATE ON public.expense_candidates FOR EACH ROW EXECUTE FUNCTION private.guard_expense_candidates();


--
-- Name: expense_splits expense_splits_balanced; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE CONSTRAINT TRIGGER expense_splits_balanced AFTER INSERT OR DELETE OR UPDATE ON public.expense_splits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.check_expense_balanced();


--
-- Name: expense_splits expense_splits_guard_immutables; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER expense_splits_guard_immutables BEFORE UPDATE ON public.expense_splits FOR EACH ROW EXECUTE FUNCTION private.guard_split_immutables();


--
-- Name: expense_splits expense_splits_guard_membership; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER expense_splits_guard_membership BEFORE INSERT ON public.expense_splits FOR EACH ROW EXECUTE FUNCTION private.guard_ledger_membership();


--
-- Name: expenses expenses_balanced; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE CONSTRAINT TRIGGER expenses_balanced AFTER INSERT OR UPDATE OF amount ON public.expenses DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.check_expense_balanced();


--
-- Name: expenses expenses_guard_immutables; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER expenses_guard_immutables BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION private.guard_expense_immutables();


--
-- Name: expenses expenses_guard_membership; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER expenses_guard_membership BEFORE INSERT OR UPDATE OF paid_by ON public.expenses FOR EACH ROW EXECUTE FUNCTION private.guard_ledger_membership();


--
-- Name: expenses expenses_set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER expenses_set_updated_at BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();


--
-- Name: group_events group_events_guard; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER group_events_guard BEFORE DELETE OR UPDATE ON public.group_events FOR EACH ROW EXECUTE FUNCTION private.guard_group_events();


--
-- Name: group_messages group_messages_immutable; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER group_messages_immutable BEFORE DELETE OR UPDATE ON public.group_messages FOR EACH ROW EXECUTE FUNCTION private.guard_group_messages();


--
-- Name: groups groups_guard_immutables; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER groups_guard_immutables BEFORE UPDATE ON public.groups FOR EACH ROW EXECUTE FUNCTION private.guard_group_immutables();


--
-- Name: groups on_group_created; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER on_group_created AFTER INSERT ON public.groups FOR EACH ROW EXECUTE FUNCTION private.handle_new_group();


--
-- Name: groups set_groups_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_groups_updated_at BEFORE UPDATE ON public.groups FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();


--
-- Name: profiles set_profiles_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();


--
-- Name: settlements settlements_guard; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER settlements_guard BEFORE DELETE OR UPDATE ON public.settlements FOR EACH ROW EXECUTE FUNCTION private.guard_settlements();


--
-- Name: expense_candidates expense_candidates_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expense_candidates
    ADD CONSTRAINT expense_candidates_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: expense_candidates expense_candidates_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expense_candidates
    ADD CONSTRAINT expense_candidates_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: expense_candidates expense_candidates_message_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expense_candidates
    ADD CONSTRAINT expense_candidates_message_fkey FOREIGN KEY (message_id, group_id) REFERENCES public.group_messages(id, group_id) ON DELETE CASCADE;


--
-- Name: expense_candidates expense_candidates_proposed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expense_candidates
    ADD CONSTRAINT expense_candidates_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: expense_candidates expense_candidates_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expense_candidates
    ADD CONSTRAINT expense_candidates_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: expense_splits expense_splits_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expense_splits
    ADD CONSTRAINT expense_splits_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON DELETE CASCADE;


--
-- Name: expense_splits expense_splits_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expense_splits
    ADD CONSTRAINT expense_splits_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: expenses expenses_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: expenses expenses_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE RESTRICT;


--
-- Name: expenses expenses_paid_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_paid_by_fkey FOREIGN KEY (paid_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: expenses expenses_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: group_events group_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_events
    ADD CONSTRAINT group_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: group_events group_events_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_events
    ADD CONSTRAINT group_events_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: group_members group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: group_members group_members_removed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_removed_by_fkey FOREIGN KEY (removed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: group_members group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: group_messages group_messages_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: group_messages group_messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: groups groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: settlements settlements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: settlements settlements_from_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_from_member_fkey FOREIGN KEY (group_id, from_user) REFERENCES public.group_members(group_id, user_id) ON DELETE RESTRICT;


--
-- Name: settlements settlements_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE RESTRICT;


--
-- Name: settlements settlements_to_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_to_member_fkey FOREIGN KEY (group_id, to_user) REFERENCES public.group_members(group_id, user_id) ON DELETE RESTRICT;


--
-- Name: settlements settlements_voided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.settlements
    ADD CONSTRAINT settlements_voided_by_fkey FOREIGN KEY (voided_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: member_add_attempts; Type: ROW SECURITY; Schema: private; Owner: postgres
--

ALTER TABLE private.member_add_attempts ENABLE ROW LEVEL SECURITY;

--
-- Name: group_messages Anonymous callers see no messages; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Anonymous callers see no messages" ON public.group_messages AS RESTRICTIVE FOR SELECT TO anon USING (false);


--
-- Name: expense_candidates Anonymous callers see no proposals; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Anonymous callers see no proposals" ON public.expense_candidates AS RESTRICTIVE FOR SELECT TO anon USING (false);


--
-- Name: expense_splits Group members can view expense splits; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Group members can view expense splits" ON public.expense_splits FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.expenses e
  WHERE ((e.id = expense_splits.expense_id) AND (e.group_id IN ( SELECT private.my_active_group_ids() AS my_active_group_ids))))));


--
-- Name: expenses Group members can view expenses; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Group members can view expenses" ON public.expenses FOR SELECT TO authenticated USING ((group_id IN ( SELECT private.my_active_group_ids() AS my_active_group_ids)));


--
-- Name: expense_candidates Members can read expense candidates; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Members can read expense candidates" ON public.expense_candidates FOR SELECT TO authenticated USING ((group_id IN ( SELECT private.my_active_group_ids() AS my_active_group_ids)));


--
-- Name: group_messages Members can read group messages; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Members can read group messages" ON public.group_messages FOR SELECT TO authenticated USING ((group_id IN ( SELECT private.my_active_group_ids() AS my_active_group_ids)));


--
-- Name: group_events Members can view group events; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Members can view group events" ON public.group_events FOR SELECT TO authenticated USING ((group_id IN ( SELECT private.my_active_group_ids() AS my_active_group_ids)));


--
-- Name: group_members Members can view group members; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Members can view group members" ON public.group_members FOR SELECT TO authenticated USING (((left_at IS NULL) AND (group_id IN ( SELECT private.my_active_group_ids() AS my_active_group_ids))));


--
-- Name: settlements Members can view group settlements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Members can view group settlements" ON public.settlements FOR SELECT TO authenticated USING ((group_id IN ( SELECT private.my_active_group_ids() AS my_active_group_ids)));


--
-- Name: groups Members can view their groups; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Members can view their groups" ON public.groups FOR SELECT TO authenticated USING ((id IN ( SELECT private.my_active_group_ids() AS my_active_group_ids)));


--
-- Name: groups Users can create groups; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users can create groups" ON public.groups FOR INSERT TO authenticated WITH CHECK ((created_by = ( SELECT auth.uid() AS uid)));


--
-- Name: profiles Users can update their own profile; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE TO authenticated USING ((( SELECT auth.uid() AS uid) = id)) WITH CHECK ((( SELECT auth.uid() AS uid) = id));


--
-- Name: profiles Users can view relevant profiles; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users can view relevant profiles" ON public.profiles FOR SELECT TO authenticated USING (((id = ( SELECT auth.uid() AS uid)) OR (id IN ( SELECT private.my_group_peer_ids() AS my_group_peer_ids))));


--
-- Name: expense_candidates; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.expense_candidates ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_splits; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.expense_splits ENABLE ROW LEVEL SECURITY;

--
-- Name: expenses; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

--
-- Name: group_events; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.group_events ENABLE ROW LEVEL SECURITY;

--
-- Name: group_members; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

--
-- Name: group_messages; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.group_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: groups; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: settlements; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.settlements ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA private; Type: ACL; Schema: -; Owner: postgres
--

GRANT USAGE ON SCHEMA private TO authenticated;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION admin_release_ownership(p_user_id uuid); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.admin_release_ownership(p_user_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION assert_expense_balanced(p_expense_id uuid); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.assert_expense_balanced(p_expense_id uuid) FROM PUBLIC;


--
-- Name: TABLE expense_candidates; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.expense_candidates TO authenticated;
GRANT SELECT ON TABLE public.expense_candidates TO anon;


--
-- Name: FUNCTION can_manage_candidate(p_candidate public.expense_candidates, p_actor uuid); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.can_manage_candidate(p_candidate public.expense_candidates, p_actor uuid) FROM PUBLIC;


--
-- Name: FUNCTION check_candidate_draft(p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text, OUT description text, OUT notes text); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.check_candidate_draft(p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text, OUT description text, OUT notes text) FROM PUBLIC;


--
-- Name: FUNCTION check_expense_balanced(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.check_expense_balanced() FROM PUBLIC;


--
-- Name: FUNCTION create_equal_split_expense_core(p_actor uuid, p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text, p_event_extra jsonb); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.create_equal_split_expense_core(p_actor uuid, p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text, p_event_extra jsonb) FROM PUBLIC;


--
-- Name: FUNCTION equal_split_cents(p_total_cents bigint, p_participant_ids uuid[]); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.equal_split_cents(p_total_cents bigint, p_participant_ids uuid[]) FROM PUBLIC;


--
-- Name: FUNCTION group_balances(p_group_id uuid); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.group_balances(p_group_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION guard_expense_candidates(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.guard_expense_candidates() FROM PUBLIC;


--
-- Name: FUNCTION guard_expense_immutables(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.guard_expense_immutables() FROM PUBLIC;


--
-- Name: FUNCTION guard_group_events(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.guard_group_events() FROM PUBLIC;


--
-- Name: FUNCTION guard_group_immutables(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.guard_group_immutables() FROM PUBLIC;


--
-- Name: FUNCTION guard_group_messages(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.guard_group_messages() FROM PUBLIC;


--
-- Name: FUNCTION guard_ledger_membership(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.guard_ledger_membership() FROM PUBLIC;


--
-- Name: FUNCTION guard_settlements(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.guard_settlements() FROM PUBLIC;


--
-- Name: FUNCTION guard_split_immutables(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.guard_split_immutables() FROM PUBLIC;


--
-- Name: FUNCTION handle_auth_user_deleting(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.handle_auth_user_deleting() FROM PUBLIC;


--
-- Name: FUNCTION handle_new_group(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.handle_new_group() FROM PUBLIC;


--
-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.handle_new_user() FROM PUBLIC;


--
-- Name: FUNCTION is_active_member_of(p_group_id uuid, p_user_id uuid); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.is_active_member_of(p_group_id uuid, p_user_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION is_active_owner_of(p_group_id uuid, p_user_id uuid); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.is_active_owner_of(p_group_id uuid, p_user_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION lock_candidate(p_id uuid, p_actor uuid); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.lock_candidate(p_id uuid, p_actor uuid) FROM PUBLIC;


--
-- Name: TABLE expenses; Type: ACL; Schema: public; Owner: postgres
--

GRANT MAINTAIN ON TABLE public.expenses TO anon;
GRANT SELECT,MAINTAIN ON TABLE public.expenses TO authenticated;
GRANT ALL ON TABLE public.expenses TO service_role;


--
-- Name: FUNCTION lock_expense_for_management(p_expense_id uuid, p_expected_updated_at timestamp with time zone); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.lock_expense_for_management(p_expense_id uuid, p_expected_updated_at timestamp with time zone) FROM PUBLIC;


--
-- Name: FUNCTION my_active_group_ids(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.my_active_group_ids() FROM PUBLIC;
GRANT ALL ON FUNCTION private.my_active_group_ids() TO authenticated;


--
-- Name: FUNCTION my_group_peer_ids(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.my_group_peer_ids() FROM PUBLIC;
GRANT ALL ON FUNCTION private.my_group_peer_ids() TO authenticated;


--
-- Name: FUNCTION record_group_event(p_group_id uuid, p_actor_id uuid, p_kind text, p_subject_id uuid, p_subject_user_id uuid, p_people uuid[], p_payload jsonb); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.record_group_event(p_group_id uuid, p_actor_id uuid, p_kind text, p_subject_id uuid, p_subject_user_id uuid, p_people uuid[], p_payload jsonb) FROM PUBLIC;


--
-- Name: FUNCTION set_updated_at(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.set_updated_at() FROM PUBLIC;


--
-- Name: FUNCTION share_lock_memberships(p_group_id uuid, p_user_ids uuid[]); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.share_lock_memberships(p_group_id uuid, p_user_ids uuid[]) FROM PUBLIC;


--
-- Name: FUNCTION add_group_member_by_email(target_group_id uuid, target_email text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text) TO authenticated;


--
-- Name: FUNCTION approve_expense_candidate(p_id uuid, p_expected_version integer); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.approve_expense_candidate(p_id uuid, p_expected_version integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.approve_expense_candidate(p_id uuid, p_expected_version integer) TO authenticated;


--
-- Name: FUNCTION create_equal_split_expense_v2(p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.create_equal_split_expense_v2(p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_equal_split_expense_v2(p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) TO authenticated;


--
-- Name: FUNCTION delete_expense(p_expense_id uuid, p_expected_updated_at timestamp with time zone); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.delete_expense(p_expense_id uuid, p_expected_updated_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delete_expense(p_expense_id uuid, p_expected_updated_at timestamp with time zone) TO authenticated;


--
-- Name: FUNCTION delete_group(p_group_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.delete_group(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delete_group(p_group_id uuid) TO authenticated;


--
-- Name: FUNCTION get_group_balances(p_group_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.get_group_balances(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_group_balances(p_group_id uuid) TO authenticated;


--
-- Name: FUNCTION get_ledger_identities(p_group_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.get_ledger_identities(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_ledger_identities(p_group_id uuid) TO authenticated;


--
-- Name: FUNCTION leave_group(p_group_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.leave_group(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.leave_group(p_group_id uuid) TO authenticated;


--
-- Name: FUNCTION propose_expense_candidate(p_message_id bigint, p_source text, p_interpreter_version text, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.propose_expense_candidate(p_message_id bigint, p_source text, p_interpreter_version text, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.propose_expense_candidate(p_message_id bigint, p_source text, p_interpreter_version text, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) TO authenticated;


--
-- Name: FUNCTION record_settlement(p_group_id uuid, p_from_user uuid, p_to_user uuid, p_amount_cents bigint, p_settled_on date, p_note text, p_client_request_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.record_settlement(p_group_id uuid, p_from_user uuid, p_to_user uuid, p_amount_cents bigint, p_settled_on date, p_note text, p_client_request_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_settlement(p_group_id uuid, p_from_user uuid, p_to_user uuid, p_amount_cents bigint, p_settled_on date, p_note text, p_client_request_id uuid) TO authenticated;


--
-- Name: FUNCTION reject_expense_candidate(p_id uuid, p_expected_version integer); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.reject_expense_candidate(p_id uuid, p_expected_version integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reject_expense_candidate(p_id uuid, p_expected_version integer) TO authenticated;


--
-- Name: FUNCTION remove_group_member(p_group_id uuid, p_user_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.remove_group_member(p_group_id uuid, p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.remove_group_member(p_group_id uuid, p_user_id uuid) TO authenticated;


--
-- Name: TABLE group_messages; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT ON TABLE public.group_messages TO authenticated;
GRANT SELECT ON TABLE public.group_messages TO anon;


--
-- Name: FUNCTION send_group_message(p_group_id uuid, p_body text, p_client_request_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.send_group_message(p_group_id uuid, p_body text, p_client_request_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.send_group_message(p_group_id uuid, p_body text, p_client_request_id uuid) TO authenticated;


--
-- Name: FUNCTION transfer_group_ownership(p_group_id uuid, p_new_owner_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.transfer_group_ownership(p_group_id uuid, p_new_owner_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.transfer_group_ownership(p_group_id uuid, p_new_owner_id uuid) TO authenticated;


--
-- Name: FUNCTION update_equal_split_expense(p_expense_id uuid, p_expected_updated_at timestamp with time zone, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.update_equal_split_expense(p_expense_id uuid, p_expected_updated_at timestamp with time zone, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.update_equal_split_expense(p_expense_id uuid, p_expected_updated_at timestamp with time zone, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) TO authenticated;


--
-- Name: FUNCTION update_expense_candidate(p_id uuid, p_expected_version integer, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.update_expense_candidate(p_id uuid, p_expected_version integer, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.update_expense_candidate(p_id uuid, p_expected_version integer, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) TO authenticated;


--
-- Name: FUNCTION update_group_details(p_group_id uuid, p_name text, p_description text, p_expected_updated_at timestamp with time zone); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.update_group_details(p_group_id uuid, p_name text, p_description text, p_expected_updated_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.update_group_details(p_group_id uuid, p_name text, p_description text, p_expected_updated_at timestamp with time zone) TO authenticated;


--
-- Name: FUNCTION void_settlement(p_settlement_id uuid, p_reason text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.void_settlement(p_settlement_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.void_settlement(p_settlement_id uuid, p_reason text) TO authenticated;


--
-- Name: TABLE expense_splits; Type: ACL; Schema: public; Owner: postgres
--

GRANT MAINTAIN ON TABLE public.expense_splits TO anon;
GRANT SELECT,MAINTAIN ON TABLE public.expense_splits TO authenticated;
GRANT ALL ON TABLE public.expense_splits TO service_role;


--
-- Name: TABLE group_events; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.group_events TO service_role;
GRANT SELECT ON TABLE public.group_events TO authenticated;


--
-- Name: SEQUENCE group_events_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.group_events_id_seq TO service_role;


--
-- Name: TABLE group_members; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,MAINTAIN ON TABLE public.group_members TO authenticated;
GRANT ALL ON TABLE public.group_members TO service_role;


--
-- Name: SEQUENCE group_messages_id_seq; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE public.group_messages_id_seq TO service_role;


--
-- Name: TABLE groups; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,MAINTAIN ON TABLE public.groups TO authenticated;
GRANT ALL ON TABLE public.groups TO service_role;


--
-- Name: COLUMN groups.name; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(name) ON TABLE public.groups TO authenticated;


--
-- Name: COLUMN groups.description; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(description) ON TABLE public.groups TO authenticated;


--
-- Name: COLUMN groups.created_by; Type: ACL; Schema: public; Owner: postgres
--

GRANT INSERT(created_by) ON TABLE public.groups TO authenticated;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,MAINTAIN ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: COLUMN profiles.full_name; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(full_name) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.avatar_url; Type: ACL; Schema: public; Owner: postgres
--

GRANT UPDATE(avatar_url) ON TABLE public.profiles TO authenticated;


--
-- Name: TABLE settlements; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.settlements TO service_role;
GRANT SELECT ON TABLE public.settlements TO authenticated;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--