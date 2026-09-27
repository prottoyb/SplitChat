-- Rollback of M12. Restores the pre-M12 legacy expense RPC body (verbatim from
-- the post-M11 schema) and drops v2, the allocation function and the
-- generated cents columns (derived data only; no ledger values change).
DROP FUNCTION public.create_equal_split_expense_v2(uuid, text, bigint, date, uuid, uuid[], text);

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

DROP FUNCTION private.equal_split_cents(bigint, uuid[]);
ALTER TABLE public.expense_splits DROP COLUMN share_cents;
ALTER TABLE public.expenses DROP COLUMN amount_cents;
