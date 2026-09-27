SET LOCAL lock_timeout = '5s';

-- M8: private helper functions replace the exposed membership helpers, and
-- RLS is rewritten around ACTIVE membership (QS-2 final, AR-8, AR-9, G1).
-- Design: docs/phase1/design.md §A2, §A4, §A6, "Operator decisions" G1 ·
-- ADR-0003, ADR-0004.
--
--  - Schema `private` (not exposed by the Data API). `authenticated` gets
--    USAGE only so RLS can call three caller-scoped, argument-free helpers.
--  - Internal checks (is_active_member_of / is_active_owner_of) take user
--    ids and are executable by no client role, so the membership-oracle class
--    is gone: public.split_chat_is_group_member, is_group_member,
--    is_group_owner and shares_group_with are dropped.
--  - Policies use the set form `x IN (SELECT private.my_active_group_ids())`
--    (one helper call per query). Former members lose all access;
--    group_members shows active rows only; profiles are visible for self and
--    active peers only (no former-member directory, G1).
--  - public.get_ledger_identities(group) returns display names only for
--    users referenced by that group's ledger who are not active members, so
--    history stays intelligible (G1). It is authorization-first.
--  - Trigger functions move to `private`. Those on public tables are dropped
--    and recreated (bodies rewritten, new OIDs, triggers recreated here);
--    handle_new_user is moved with SET SCHEMA so the platform-owned
--    auth.users trigger needs no DDL. All of them still fire (see tests).
--  - The expense RPC checks ACTIVE membership via the private helper.

GRANT USAGE ON SCHEMA private TO authenticated;

-- Internal checks (no client EXECUTE) --------------------------------------
CREATE FUNCTION private.is_active_member_of(p_group_id uuid, p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members gm
     WHERE gm.group_id = p_group_id AND gm.user_id = p_user_id AND gm.left_at IS NULL
  )
$$;

CREATE FUNCTION private.is_active_owner_of(p_group_id uuid, p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members gm
     WHERE gm.group_id = p_group_id AND gm.user_id = p_user_id
       AND gm.role = 'owner' AND gm.left_at IS NULL
  )
$$;

-- Caller-scoped RLS helpers (EXECUTE for authenticated only) --------------
CREATE FUNCTION private.my_active_group_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT gm.group_id FROM public.group_members gm
   WHERE gm.user_id = (SELECT auth.uid()) AND gm.left_at IS NULL
$$;

CREATE FUNCTION private.my_group_peer_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT DISTINCT peer.user_id
    FROM public.group_members me
    JOIN public.group_members peer ON peer.group_id = me.group_id
   WHERE me.user_id = (SELECT auth.uid()) AND me.left_at IS NULL AND peer.left_at IS NULL
$$;

-- Interim: used only by the group_members DELETE policy until M10.
CREATE FUNCTION private.my_owned_group_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT gm.group_id FROM public.group_members gm
   WHERE gm.user_id = (SELECT auth.uid()) AND gm.role = 'owner' AND gm.left_at IS NULL
$$;

REVOKE ALL ON FUNCTION private.is_active_member_of(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.is_active_owner_of(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.my_active_group_ids() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.my_group_peer_ids() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.my_owned_group_ids() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.my_active_group_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION private.my_group_peer_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION private.my_owned_group_ids() TO authenticated;

-- Trigger functions in private ----------------------------------------------
CREATE FUNCTION private.set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

CREATE FUNCTION private.handle_new_group() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (NEW.id, NEW.created_by, 'owner');
  RETURN NEW;
END
$$;

-- handle_new_user is MOVED, not recreated: the trigger on auth.users stays
-- bound to the same function, because postgres does not own auth.users
-- (platform-owned) and must not drop or recreate triggers there. The body
-- is then replaced in place (same OID).
ALTER FUNCTION public.handle_new_user() SET SCHEMA private;
CREATE OR REPLACE FUNCTION private.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
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

REVOKE ALL ON FUNCTION private.set_updated_at() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.handle_new_group() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.handle_new_user() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER expenses_set_updated_at ON public.expenses;
DROP TRIGGER on_group_created ON public.groups;
DROP TRIGGER set_groups_updated_at ON public.groups;
DROP TRIGGER set_profiles_updated_at ON public.profiles;

CREATE TRIGGER expenses_set_updated_at BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER on_group_created AFTER INSERT ON public.groups
  FOR EACH ROW EXECUTE FUNCTION private.handle_new_group();
CREATE TRIGGER set_groups_updated_at BEFORE UPDATE ON public.groups
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();
CREATE TRIGGER set_profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.set_updated_at();

-- Policies around active membership --------------------------------------
DROP POLICY "Members can view their groups" ON public.groups;
DROP POLICY "Members can view group members" ON public.group_members;
DROP POLICY "Owners can remove members and members can leave" ON public.group_members;
DROP POLICY "Group members can view expenses" ON public.expenses;
DROP POLICY "Group members can view expense splits" ON public.expense_splits;
DROP POLICY "Users can view relevant profiles" ON public.profiles;

CREATE POLICY "Members can view their groups" ON public.groups
  FOR SELECT TO authenticated
  USING (id IN (SELECT private.my_active_group_ids()));

CREATE POLICY "Members can view group members" ON public.group_members
  FOR SELECT TO authenticated
  USING (left_at IS NULL AND group_id IN (SELECT private.my_active_group_ids()));

-- Interim until M10 (the frontend moves to leave/remove RPCs in M9).
CREATE POLICY "Owners can remove members and members can leave" ON public.group_members
  FOR DELETE TO authenticated
  USING (
    (group_id IN (SELECT private.my_owned_group_ids()) AND user_id <> (SELECT auth.uid()))
    OR (user_id = (SELECT auth.uid()) AND group_id NOT IN (SELECT private.my_owned_group_ids()))
  );

CREATE POLICY "Group members can view expenses" ON public.expenses
  FOR SELECT TO authenticated
  USING (group_id IN (SELECT private.my_active_group_ids()));

CREATE POLICY "Group members can view expense splits" ON public.expense_splits
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.expenses e
     WHERE e.id = expense_splits.expense_id
       AND e.group_id IN (SELECT private.my_active_group_ids())
  ));

CREATE POLICY "Users can view relevant profiles" ON public.profiles
  FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()) OR id IN (SELECT private.my_group_peer_ids()));

-- Expense RPC: active membership via the private helper -------------------
CREATE OR REPLACE FUNCTION public.create_equal_split_expense(p_group_id uuid, p_description text, p_amount numeric, p_expense_date date, p_paid_by uuid, p_participant_ids uuid[], p_notes text DEFAULT NULL::text) RETURNS uuid
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

    if not private.is_active_member_of(
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

    if not private.is_active_member_of(
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
    where private.is_active_member_of(
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

-- Historical identities for ledger rendering (G1) ---------------------------
CREATE FUNCTION public.get_ledger_identities(p_group_id uuid)
RETURNS TABLE(user_id uuid, display_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
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
REVOKE ALL ON FUNCTION public.get_ledger_identities(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_ledger_identities(uuid) TO authenticated;

-- Drop the exposed helpers and the old trigger functions -----------------
DROP FUNCTION public.split_chat_is_group_member(uuid, uuid);
DROP FUNCTION public.is_group_member(uuid);
DROP FUNCTION public.is_group_owner(uuid);
DROP FUNCTION public.shares_group_with(uuid);
DROP FUNCTION public.set_expenses_updated_at();
DROP FUNCTION public.set_updated_at();
DROP FUNCTION public.handle_new_group();
