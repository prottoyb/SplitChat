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
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (
    NEW.id,
    coalesce(
      nullif(trim(NEW.raw_user_meta_data ->> 'full_name'), ''),
      split_part(coalesce(NEW.email, ''), '@', 1)
    )
  )
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

SET default_tablespace = '';

SET default_table_access_method = heap;

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

  -- Serialise with the account-deletion trigger and other membership changes
  -- on this group, then re-check ownership under the lock: the owner may
  -- have deleted their account while this call waited (QS-B3-1).
  PERFORM 1 FROM public.groups g WHERE g.id = target_group_id FOR UPDATE;
  IF NOT private.is_active_owner_of(target_group_id, v_uid) THEN
    RAISE EXCEPTION 'not_found_or_forbidden' USING ERRCODE = 'P0001';
  END IF;

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
  ELSE
    BEGIN
      INSERT INTO public.group_members (group_id, user_id, role)
      VALUES (target_group_id, v_target, 'member');
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
-- Name: create_equal_split_expense_v2(uuid, text, bigint, date, uuid, uuid[], text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_equal_split_expense_v2(p_group_id uuid, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text DEFAULT NULL::text) RETURNS uuid
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

  RETURN v_expense_id;
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
BEGIN
  v_expense := private.lock_expense_for_management(p_expense_id, p_expected_updated_at);
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
                 WHERE e.group_id = p_group_id AND s.user_id <> v_uid) THEN
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
END
$$;


ALTER FUNCTION public.leave_group(p_group_id uuid) OWNER TO postgres;

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

  PERFORM 1 FROM public.group_members gm
   WHERE gm.group_id = p_group_id AND gm.user_id = p_user_id AND gm.left_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.group_members
     SET left_at = now(), left_reason = 'removed', removed_by = v_uid
   WHERE group_id = p_group_id AND user_id = p_user_id;
END
$$;


ALTER FUNCTION public.remove_group_member(p_group_id uuid, p_user_id uuid) OWNER TO postgres;

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


ALTER FUNCTION public.update_equal_split_expense(p_expense_id uuid, p_expected_updated_at timestamp with time zone, p_description text, p_amount_cents bigint, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) OWNER TO postgres;

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
-- Name: member_add_attempts member_add_attempts_pkey; Type: CONSTRAINT; Schema: private; Owner: postgres
--

ALTER TABLE ONLY private.member_add_attempts
    ADD CONSTRAINT member_add_attempts_pkey PRIMARY KEY (id);


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
-- Name: group_members group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_pkey PRIMARY KEY (group_id, user_id);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: member_add_attempts_caller_time_idx; Type: INDEX; Schema: private; Owner: postgres
--

CREATE INDEX member_add_attempts_caller_time_idx ON private.member_add_attempts USING btree (caller_id, attempted_at);


--
-- Name: expense_splits_expense_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX expense_splits_expense_id_idx ON public.expense_splits USING btree (expense_id);


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
-- Name: expenses_group_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX expenses_group_id_idx ON public.expenses USING btree (group_id);


--
-- Name: expenses_paid_by_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX expenses_paid_by_idx ON public.expenses USING btree (paid_by);


--
-- Name: group_members_one_active_owner; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX group_members_one_active_owner ON public.group_members USING btree (group_id) WHERE ((role = 'owner'::text) AND (left_at IS NULL));


--
-- Name: group_members_user_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX group_members_user_id_idx ON public.group_members USING btree (user_id);


--
-- Name: groups_created_by_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX groups_created_by_idx ON public.groups USING btree (created_by);


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
-- Name: groups groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: member_add_attempts; Type: ROW SECURITY; Schema: private; Owner: postgres
--

ALTER TABLE private.member_add_attempts ENABLE ROW LEVEL SECURITY;

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
-- Name: group_members Members can view group members; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Members can view group members" ON public.group_members FOR SELECT TO authenticated USING (((left_at IS NULL) AND (group_id IN ( SELECT private.my_active_group_ids() AS my_active_group_ids))));


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
-- Name: expense_splits; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.expense_splits ENABLE ROW LEVEL SECURITY;

--
-- Name: expenses; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

--
-- Name: group_members; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

--
-- Name: groups; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

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
-- Name: FUNCTION check_expense_balanced(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.check_expense_balanced() FROM PUBLIC;


--
-- Name: FUNCTION equal_split_cents(p_total_cents bigint, p_participant_ids uuid[]); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.equal_split_cents(p_total_cents bigint, p_participant_ids uuid[]) FROM PUBLIC;


--
-- Name: FUNCTION guard_expense_immutables(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.guard_expense_immutables() FROM PUBLIC;


--
-- Name: FUNCTION guard_group_immutables(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.guard_group_immutables() FROM PUBLIC;


--
-- Name: FUNCTION guard_ledger_membership(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.guard_ledger_membership() FROM PUBLIC;


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
-- Name: FUNCTION set_updated_at(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.set_updated_at() FROM PUBLIC;


--
-- Name: FUNCTION add_group_member_by_email(target_group_id uuid, target_email text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text) TO authenticated;


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
-- Name: FUNCTION remove_group_member(p_group_id uuid, p_user_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.remove_group_member(p_group_id uuid, p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.remove_group_member(p_group_id uuid, p_user_id uuid) TO authenticated;


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
-- Name: TABLE expense_splits; Type: ACL; Schema: public; Owner: postgres
--

GRANT MAINTAIN ON TABLE public.expense_splits TO anon;
GRANT SELECT,MAINTAIN ON TABLE public.expense_splits TO authenticated;
GRANT ALL ON TABLE public.expense_splits TO service_role;


--
-- Name: TABLE group_members; Type: ACL; Schema: public; Owner: postgres
--

GRANT SELECT,MAINTAIN ON TABLE public.group_members TO authenticated;
GRANT ALL ON TABLE public.group_members TO service_role;


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