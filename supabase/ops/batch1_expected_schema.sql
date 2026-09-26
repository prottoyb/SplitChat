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
-- Name: add_group_member_by_email(uuid, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text) RETURNS TABLE(added_user_id uuid, added_full_name text, added_role text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  current_user_id uuid;
  found_user_id uuid;
  found_full_name text;
  clean_email text;
begin

  -- -------------------------------------------------------
  -- 1. Identify caller
  -- -------------------------------------------------------

  current_user_id := (select auth.uid());

  if current_user_id is null then
    raise exception 'Authentication required.';
  end if;


  -- -------------------------------------------------------
  -- 2. Validate email
  -- -------------------------------------------------------

  clean_email := lower(btrim(coalesce(target_email, '')));

  if clean_email = '' then
    raise exception 'Please enter an email address.';
  end if;


  -- -------------------------------------------------------
  -- 3. Verify caller owns this group
  --
  -- Important: ownership is checked BEFORE looking up
  -- another user's email.
  -- -------------------------------------------------------

  if not exists (
    select 1
    from public.groups g
    where g.id = target_group_id
      and g.created_by = current_user_id
  ) then
    raise exception 'Only the group owner can add members.';
  end if;


  -- -------------------------------------------------------
  -- 4. Find registered SplitChat user
  -- -------------------------------------------------------

  select
    u.id,
    coalesce(
      nullif(btrim(p.full_name), ''),
      split_part(coalesce(u.email, ''), '@', 1)
    )
  into
    found_user_id,
    found_full_name
  from auth.users u
  left join public.profiles p
    on p.id = u.id
  where lower(u.email) = clean_email
  limit 1;


  if found_user_id is null then
    raise exception 'No SplitChat account was found for that email address.';
  end if;


  -- -------------------------------------------------------
  -- 5. Prevent owner adding themselves again
  -- -------------------------------------------------------

  if found_user_id = current_user_id then
    raise exception 'You are already the owner of this group.';
  end if;


  -- -------------------------------------------------------
  -- 6. Prevent duplicate membership
  -- -------------------------------------------------------

  if exists (
    select 1
    from public.group_members gm
    where gm.group_id = target_group_id
      and gm.user_id = found_user_id
  ) then
    raise exception 'This user is already a member of the group.';
  end if;


  -- -------------------------------------------------------
  -- 7. Add member
  --
  -- Role is deliberately hard-coded to member.
  -- Browser clients cannot create another owner.
  -- -------------------------------------------------------

  insert into public.group_members (
    group_id,
    user_id,
    role
  )
  values (
    target_group_id,
    found_user_id,
    'member'
  );


  -- -------------------------------------------------------
  -- 8. Return safe application-facing information
  -- -------------------------------------------------------

  return query
  select
    found_user_id,
    found_full_name,
    'member'::text;

end;
$$;


ALTER FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text) OWNER TO postgres;

--
-- Name: create_equal_split_expense(uuid, text, numeric, date, uuid, uuid[], text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.create_equal_split_expense(p_group_id uuid, p_description text, p_amount numeric, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
    v_user_id uuid := auth.uid();

    v_description text;
    v_notes text;
    v_amount numeric(12, 2);

    v_participants uuid[];
    v_participant_count integer;
    v_valid_member_count integer;

    v_total_cents bigint;
    v_base_cents bigint;
    v_remainder bigint;
    v_share_cents bigint;

    v_index integer;
    v_expense_id uuid;
begin

    -- ========================================================
    -- 1. AUTHENTICATION
    -- ========================================================

    if v_user_id is null then
        raise exception 'Authentication required.';
    end if;


    -- ========================================================
    -- 2. GROUP VALIDATION
    -- ========================================================

    if p_group_id is null then
        raise exception 'Group is required.';
    end if;

    if not public.split_chat_is_group_member(
        p_group_id,
        v_user_id
    ) then
        raise exception 'You do not have access to this group.';
    end if;


    -- ========================================================
    -- 3. DESCRIPTION VALIDATION
    -- ========================================================

    v_description := btrim(coalesce(p_description, ''));

    if char_length(v_description) = 0 then
        raise exception 'Expense description is required.';
    end if;

    if char_length(v_description) > 120 then
        raise exception 'Expense description cannot exceed 120 characters.';
    end if;


    -- ========================================================
    -- 4. AMOUNT VALIDATION
    -- ========================================================

    if p_amount is null then
        raise exception 'Expense amount is required.';
    end if;

    if p_amount <= 0 then
        raise exception 'Expense amount must be greater than zero.';
    end if;

    if p_amount <> round(p_amount, 2) then
        raise exception 'Expense amount can have at most 2 decimal places.';
    end if;

    if p_amount > 9999999999.99 then
        raise exception 'Expense amount is too large.';
    end if;

    v_amount := p_amount;


    -- ========================================================
    -- 5. DATE VALIDATION
    -- ========================================================

    if p_expense_date is null then
        raise exception 'Expense date is required.';
    end if;


    -- ========================================================
    -- 6. PAYER VALIDATION
    -- ========================================================

    if p_paid_by is null then
        raise exception 'A payer is required.';
    end if;

    if not public.split_chat_is_group_member(
        p_group_id,
        p_paid_by
    ) then
        raise exception 'The selected payer is not a member of this group.';
    end if;


    -- ========================================================
    -- 7. PARTICIPANT CLEANUP
    -- Remove null values and duplicate users while preserving
    -- the order of their first appearance in the input array.
    -- ========================================================

    select array_agg(
        participant_data.participant_id
        order by participant_data.first_position
    )
    into v_participants
    from (
        select
            participant_id,
            min(position) as first_position
        from unnest(p_participant_ids)
            with ordinality as participant_list(
                participant_id,
                position
            )
        where participant_id is not null
        group by participant_id
    ) as participant_data;


    v_participant_count :=
        coalesce(cardinality(v_participants), 0);

    if v_participant_count = 0 then
        raise exception 'At least one participant is required.';
    end if;


    -- ========================================================
    -- 8. VERIFY EVERY PARTICIPANT BELONGS TO THE GROUP
    -- ========================================================

    select count(*)
    into v_valid_member_count
    from unnest(v_participants) as selected_participant(user_id)
    where public.split_chat_is_group_member(
        p_group_id,
        selected_participant.user_id
    );

    if v_valid_member_count <> v_participant_count then
        raise exception 'One or more selected participants are not members of this group.';
    end if;


    -- ========================================================
    -- 9. NOTES VALIDATION
    -- ========================================================

    v_notes := nullif(
        btrim(coalesce(p_notes, '')),
        ''
    );

    if v_notes is not null
       and char_length(v_notes) > 500 then
        raise exception 'Notes cannot exceed 500 characters.';
    end if;


    -- ========================================================
    -- 10. CALCULATE EQUAL SPLIT USING INTEGER CENTS
    --
    -- Example:
    -- $100 / 3
    --
    -- Participant 1 = $33.34
    -- Participant 2 = $33.33
    -- Participant 3 = $33.33
    --
    -- Total remains exactly $100.00.
    -- ========================================================

    v_total_cents := round(v_amount * 100)::bigint;

    if v_total_cents < v_participant_count then
        raise exception
            'Expense amount is too small to split between the selected participants.';
    end if;

    v_base_cents :=
        v_total_cents / v_participant_count;

    v_remainder :=
        v_total_cents % v_participant_count;


    -- ========================================================
    -- 11. CREATE EXPENSE
    -- ========================================================

    insert into public.expenses (
        group_id,
        description,
        amount,
        expense_date,
        paid_by,
        created_by,
        split_type,
        notes
    )
    values (
        p_group_id,
        v_description,
        v_amount,
        p_expense_date,
        p_paid_by,
        v_user_id,
        'equal',
        v_notes
    )
    returning id
    into v_expense_id;


    -- ========================================================
    -- 12. CREATE SPLIT ROWS
    --
    -- Any remainder cents are assigned one cent at a time
    -- starting with the first participant.
    -- ========================================================

    for v_index in 1..v_participant_count loop

        v_share_cents :=
            v_base_cents
            +
            case
                when v_index <= v_remainder then 1
                else 0
            end;

        insert into public.expense_splits (
            expense_id,
            user_id,
            share_amount,
            percentage
        )
        values (
            v_expense_id,
            v_participants[v_index],
            (v_share_cents::numeric / 100)::numeric(12, 2),
            null
        );

    end loop;


    -- ========================================================
    -- 13. RETURN NEW EXPENSE ID
    -- ========================================================

    return v_expense_id;

end;
$_$;


ALTER FUNCTION public.create_equal_split_expense(p_group_id uuid, p_description text, p_amount numeric, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) OWNER TO postgres;

--
-- Name: FUNCTION create_equal_split_expense(p_group_id uuid, p_description text, p_amount numeric, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.create_equal_split_expense(p_group_id uuid, p_description text, p_amount numeric, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) IS 'Creates one SplitChat expense and its equal participant splits atomically.';


--
-- Name: handle_new_group(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.handle_new_group() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  insert into public.group_members (
    group_id,
    user_id,
    role
  )
  values (
    new.id,
    new.created_by,
    'owner'
  );

  return new;
end;
$$;


ALTER FUNCTION public.handle_new_group() OWNER TO postgres;

--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  insert into public.profiles (
    id,
    full_name
  )
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      split_part(coalesce(new.email, ''), '@', 1)
    )
  )
  on conflict (id) do nothing;

  return new;
end;
$$;


ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

--
-- Name: is_group_member(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_group_member(target_group_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.group_members gm
    where gm.group_id = target_group_id
      and gm.user_id = (select auth.uid())
  );
$$;


ALTER FUNCTION public.is_group_member(target_group_id uuid) OWNER TO postgres;

--
-- Name: is_group_owner(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_group_owner(target_group_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.groups g
    where g.id = target_group_id
      and g.created_by = (select auth.uid())
  );
$$;


ALTER FUNCTION public.is_group_owner(target_group_id uuid) OWNER TO postgres;

--
-- Name: set_expenses_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.set_expenses_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
    new.updated_at = now();
    return new;
end;
$$;


ALTER FUNCTION public.set_expenses_updated_at() OWNER TO postgres;

--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION public.set_updated_at() OWNER TO postgres;

--
-- Name: shares_group_with(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.shares_group_with(target_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select exists (
    select 1
    from public.group_members current_member
    inner join public.group_members target_member
      on target_member.group_id = current_member.group_id
    where current_member.user_id = (select auth.uid())
      and target_member.user_id = target_user_id
  );
$$;


ALTER FUNCTION public.shares_group_with(target_user_id uuid) OWNER TO postgres;

--
-- Name: split_chat_is_group_member(uuid, uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.split_chat_is_group_member(target_group_id uuid, target_user_id uuid DEFAULT auth.uid()) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
    select exists (
        select 1
        from public.group_members gm
        where gm.group_id = target_group_id
          and gm.user_id = target_user_id
    );
$$;


ALTER FUNCTION public.split_chat_is_group_member(target_group_id uuid, target_user_id uuid) OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

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
    CONSTRAINT expense_splits_percentage_check CHECK (((percentage IS NULL) OR ((percentage >= (0)::numeric) AND (percentage <= (100)::numeric)))),
    CONSTRAINT expense_splits_share_amount_check CHECK ((share_amount >= (0)::numeric))
);


ALTER TABLE public.expense_splits OWNER TO postgres;

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
    CONSTRAINT expenses_amount_positive_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT expenses_description_length_check CHECK (((char_length(btrim(description)) >= 1) AND (char_length(btrim(description)) <= 120))),
    CONSTRAINT expenses_notes_length_check CHECK (((notes IS NULL) OR (char_length(notes) <= 500))),
    CONSTRAINT expenses_split_type_check CHECK ((split_type = 'equal'::text))
);


ALTER TABLE public.expenses OWNER TO postgres;

--
-- Name: group_members; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.group_members (
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
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
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.profiles OWNER TO postgres;

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

CREATE TRIGGER expenses_set_updated_at BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.set_expenses_updated_at();


--
-- Name: groups on_group_created; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER on_group_created AFTER INSERT ON public.groups FOR EACH ROW EXECUTE FUNCTION public.handle_new_group();


--
-- Name: groups set_groups_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_groups_updated_at BEFORE UPDATE ON public.groups FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: profiles set_profiles_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


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
    ADD CONSTRAINT expenses_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: expenses expenses_paid_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_paid_by_fkey FOREIGN KEY (paid_by) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: group_members group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: group_members group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_members
    ADD CONSTRAINT group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: groups groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: expense_splits Group members can view expense splits; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Group members can view expense splits" ON public.expense_splits FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.expenses e
  WHERE ((e.id = expense_splits.expense_id) AND public.split_chat_is_group_member(e.group_id, auth.uid())))));


--
-- Name: expenses Group members can view expenses; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Group members can view expenses" ON public.expenses FOR SELECT TO authenticated USING (public.split_chat_is_group_member(group_id, auth.uid()));


--
-- Name: group_members Members can view group members; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Members can view group members" ON public.group_members FOR SELECT TO authenticated USING (public.is_group_member(group_id));


--
-- Name: groups Members can view their groups; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Members can view their groups" ON public.groups FOR SELECT TO authenticated USING (public.is_group_member(id));


--
-- Name: group_members Owners can add group members; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can add group members" ON public.group_members FOR INSERT TO authenticated WITH CHECK ((public.is_group_owner(group_id) AND (role = 'member'::text)));


--
-- Name: groups Owners can delete groups; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can delete groups" ON public.groups FOR DELETE TO authenticated USING (public.is_group_owner(id));


--
-- Name: group_members Owners can remove members and members can leave; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can remove members and members can leave" ON public.group_members FOR DELETE TO authenticated USING (((public.is_group_owner(group_id) AND (user_id <> ( SELECT auth.uid() AS uid))) OR ((user_id = ( SELECT auth.uid() AS uid)) AND (NOT public.is_group_owner(group_id)))));


--
-- Name: groups Owners can update groups; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can update groups" ON public.groups FOR UPDATE TO authenticated USING (public.is_group_owner(id)) WITH CHECK ((created_by = ( SELECT auth.uid() AS uid)));


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

CREATE POLICY "Users can view relevant profiles" ON public.profiles FOR SELECT TO authenticated USING (((id = ( SELECT auth.uid() AS uid)) OR public.shares_group_with(id)));


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
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION assert_expense_balanced(p_expense_id uuid); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.assert_expense_balanced(p_expense_id uuid) FROM PUBLIC;


--
-- Name: FUNCTION check_expense_balanced(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.check_expense_balanced() FROM PUBLIC;


--
-- Name: FUNCTION guard_expense_immutables(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.guard_expense_immutables() FROM PUBLIC;


--
-- Name: FUNCTION guard_ledger_membership(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.guard_ledger_membership() FROM PUBLIC;


--
-- Name: FUNCTION guard_split_immutables(); Type: ACL; Schema: private; Owner: postgres
--

REVOKE ALL ON FUNCTION private.guard_split_immutables() FROM PUBLIC;


--
-- Name: FUNCTION add_group_member_by_email(target_group_id uuid, target_email text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text) TO authenticated;
GRANT ALL ON FUNCTION public.add_group_member_by_email(target_group_id uuid, target_email text) TO service_role;


--
-- Name: FUNCTION create_equal_split_expense(p_group_id uuid, p_description text, p_amount numeric, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.create_equal_split_expense(p_group_id uuid, p_description text, p_amount numeric, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_equal_split_expense(p_group_id uuid, p_description text, p_amount numeric, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) TO authenticated;
GRANT ALL ON FUNCTION public.create_equal_split_expense(p_group_id uuid, p_description text, p_amount numeric, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text) TO service_role;


--
-- Name: FUNCTION handle_new_group(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.handle_new_group() FROM PUBLIC;
GRANT ALL ON FUNCTION public.handle_new_group() TO service_role;


--
-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;


--
-- Name: FUNCTION is_group_member(target_group_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.is_group_member(target_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_group_member(target_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_group_member(target_group_id uuid) TO service_role;


--
-- Name: FUNCTION is_group_owner(target_group_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.is_group_owner(target_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_group_owner(target_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_group_owner(target_group_id uuid) TO service_role;


--
-- Name: FUNCTION set_expenses_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.set_expenses_updated_at() FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_expenses_updated_at() TO service_role;


--
-- Name: FUNCTION set_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_updated_at() TO service_role;


--
-- Name: FUNCTION shares_group_with(target_user_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.shares_group_with(target_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.shares_group_with(target_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.shares_group_with(target_user_id uuid) TO service_role;


--
-- Name: FUNCTION split_chat_is_group_member(target_group_id uuid, target_user_id uuid); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.split_chat_is_group_member(target_group_id uuid, target_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.split_chat_is_group_member(target_group_id uuid, target_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.split_chat_is_group_member(target_group_id uuid, target_user_id uuid) TO service_role;


--
-- Name: TABLE expense_splits; Type: ACL; Schema: public; Owner: postgres
--

GRANT MAINTAIN ON TABLE public.expense_splits TO anon;
GRANT SELECT,MAINTAIN ON TABLE public.expense_splits TO authenticated;
GRANT ALL ON TABLE public.expense_splits TO service_role;


--
-- Name: TABLE expenses; Type: ACL; Schema: public; Owner: postgres
--

GRANT MAINTAIN ON TABLE public.expenses TO anon;
GRANT SELECT,MAINTAIN ON TABLE public.expenses TO authenticated;
GRANT ALL ON TABLE public.expenses TO service_role;


--
-- Name: TABLE group_members; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.group_members TO authenticated;
GRANT ALL ON TABLE public.group_members TO service_role;


--
-- Name: TABLE groups; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.groups TO authenticated;
GRANT ALL ON TABLE public.groups TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.profiles TO anon;
GRANT ALL ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
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
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
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
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
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