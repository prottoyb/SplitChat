-- Rollback of M8. Recovery only: restores the exposed public helper
-- functions and the pre-M8 RLS policies (including the signed-in
-- membership oracle). Generated verbatim from the post-M7 schema. In
-- production, apply as a new forward migration under its own approval.

-- 1. Old public functions, exactly as they were after M7. handle_new_user
--    is moved back (same OID, so the auth.users trigger stays bound).
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

ALTER FUNCTION private.handle_new_user() SET SCHEMA public;
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
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

REVOKE ALL ON FUNCTION public.handle_new_group() FROM PUBLIC;
GRANT ALL ON FUNCTION public.handle_new_group() TO service_role;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;
REVOKE ALL ON FUNCTION public.is_group_member(target_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_group_member(target_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_group_member(target_group_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.is_group_owner(target_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_group_owner(target_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_group_owner(target_group_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.set_expenses_updated_at() FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_expenses_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_updated_at() TO service_role;
REVOKE ALL ON FUNCTION public.shares_group_with(target_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.shares_group_with(target_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.shares_group_with(target_user_id uuid) TO service_role;
REVOKE ALL ON FUNCTION public.split_chat_is_group_member(target_group_id uuid, target_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.split_chat_is_group_member(target_group_id uuid, target_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.split_chat_is_group_member(target_group_id uuid, target_user_id uuid) TO service_role;

-- 2. Triggers back onto the public functions.
DROP TRIGGER expenses_set_updated_at ON public.expenses;
DROP TRIGGER on_group_created ON public.groups;
DROP TRIGGER set_groups_updated_at ON public.groups;
DROP TRIGGER set_profiles_updated_at ON public.profiles;
CREATE TRIGGER expenses_set_updated_at BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.set_expenses_updated_at();
CREATE TRIGGER on_group_created AFTER INSERT ON public.groups FOR EACH ROW EXECUTE FUNCTION public.handle_new_group();
CREATE TRIGGER set_groups_updated_at BEFORE UPDATE ON public.groups FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER set_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3. Pre-M8 policies.
DROP POLICY "Group members can view expense splits" ON public.expense_splits;
DROP POLICY "Group members can view expenses" ON public.expenses;
DROP POLICY "Members can view group members" ON public.group_members;
DROP POLICY "Members can view their groups" ON public.groups;
DROP POLICY "Owners can remove members and members can leave" ON public.group_members;
DROP POLICY "Users can view relevant profiles" ON public.profiles;
CREATE POLICY "Group members can view expense splits" ON public.expense_splits FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.expenses e
  WHERE ((e.id = expense_splits.expense_id) AND public.split_chat_is_group_member(e.group_id, auth.uid())))));
CREATE POLICY "Group members can view expenses" ON public.expenses FOR SELECT TO authenticated USING (public.split_chat_is_group_member(group_id, auth.uid()));
CREATE POLICY "Members can view group members" ON public.group_members FOR SELECT TO authenticated USING (public.is_group_member(group_id));
CREATE POLICY "Members can view their groups" ON public.groups FOR SELECT TO authenticated USING (public.is_group_member(id));
CREATE POLICY "Owners can remove members and members can leave" ON public.group_members FOR DELETE TO authenticated USING (((public.is_group_owner(group_id) AND (user_id <> ( SELECT auth.uid() AS uid))) OR ((user_id = ( SELECT auth.uid() AS uid)) AND (NOT public.is_group_owner(group_id)))));
CREATE POLICY "Users can view relevant profiles" ON public.profiles FOR SELECT TO authenticated USING (((id = ( SELECT auth.uid() AS uid)) OR public.shares_group_with(id)));

-- 4. Expense RPC body with the public membership helper.
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

-- 5. Drop what M8 added.
DROP FUNCTION public.get_ledger_identities(uuid);
DROP FUNCTION private.handle_new_group();
DROP FUNCTION private.set_updated_at();
DROP FUNCTION private.my_owned_group_ids();
DROP FUNCTION private.my_group_peer_ids();
DROP FUNCTION private.my_active_group_ids();
DROP FUNCTION private.is_active_owner_of(uuid, uuid);
DROP FUNCTION private.is_active_member_of(uuid, uuid);
REVOKE USAGE ON SCHEMA private FROM authenticated;
