SET LOCAL lock_timeout = '5s';

-- M17: settlements, server-authoritative balances (ADR-0010, accepted after
-- Software Architect review, conditions 1-10).
--
--  - public.settlements: a payment from one group member to another
--    (current or former), integer cents. Clients can only SELECT, only for
--    groups they are an active member of. Settlements are voided, never
--    deleted: the only permitted UPDATE sets the void columns once.
--  - Both parties need a membership row in the group (composite foreign
--    keys, as for splits); membership rows are never deleted while a
--    settlement references them.
--  - private.group_balances(group): per person, paid - owed + settled out -
--    settled in (non-voided), from the tables of record in one query. Sums to
--    zero over a group. get_group_balances exposes it to active members.
--  - record_settlement: authorization, input checks, then the group row lock
--    and authorization again under it; the amount must not exceed what the
--    payer owes or the payee is owed right now, so a settlement can never
--    over-settle or reverse a debt. Partial amounts are allowed. The group
--    lock serialises settlements with each other and with expense creation
--    (whose foreign key needs a key-share lock on the same row).
--  - void_settlement: either party or the active owner; locks the group,
--    then the settlement.
--  - Events (ADR-0009): settlement_recorded / settlement_voided in the same
--    transaction; ids, cents and the date only (never the note or reason).
--    The events' people keep both parties nameable by get_ledger_identities.
--  - delete_group refuses a group with settlements (backstop only).
--
-- Rollback: drops settlements and their events' kinds. Once settlements
-- exist in production it discards payment history: fix-forward, and any
-- rollback needs its own approval.

CREATE TABLE public.settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.groups (id) ON DELETE RESTRICT,
  from_user uuid NOT NULL,
  to_user uuid NOT NULL,
  amount_cents bigint NOT NULL,
  settled_on date NOT NULL,
  note text,
  client_request_id uuid,
  created_by uuid NOT NULL REFERENCES public.profiles (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid REFERENCES public.profiles (id) ON DELETE RESTRICT,
  void_reason text,
  CONSTRAINT settlements_from_member_fkey FOREIGN KEY (group_id, from_user)
    REFERENCES public.group_members (group_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT settlements_to_member_fkey FOREIGN KEY (group_id, to_user)
    REFERENCES public.group_members (group_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT settlements_distinct_parties CHECK (from_user <> to_user),
  CONSTRAINT settlements_amount_check CHECK (amount_cents > 0 AND amount_cents <= 999999999999),
  CONSTRAINT settlements_settled_on_check CHECK (settled_on >= DATE '2000-01-01'),
  CONSTRAINT settlements_note_check
    CHECK (note IS NULL OR (char_length(note) BETWEEN 1 AND 200 AND note = btrim(note))),
  CONSTRAINT settlements_void_consistency
    CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL)),
  CONSTRAINT settlements_void_reason_check
    CHECK (void_reason IS NULL OR (char_length(void_reason) BETWEEN 1 AND 200 AND void_reason = btrim(void_reason))),
  CONSTRAINT settlements_request_unique UNIQUE (group_id, created_by, client_request_id)
);
CREATE INDEX settlements_group_idx ON public.settlements (group_id, settled_on DESC, created_at DESC);
CREATE INDEX settlements_from_user_idx ON public.settlements (from_user);
CREATE INDEX settlements_to_user_idx ON public.settlements (to_user);

ALTER TABLE public.settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.settlements FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.settlements TO authenticated;
CREATE POLICY "Members can view group settlements" ON public.settlements
  FOR SELECT TO authenticated
  USING (group_id IN (SELECT private.my_active_group_ids()));

-- Void-only immutability (condition 3).
CREATE FUNCTION private.guard_settlements() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
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
REVOKE ALL ON FUNCTION private.guard_settlements() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER settlements_guard
  BEFORE UPDATE OR DELETE ON public.settlements
  FOR EACH ROW EXECUTE FUNCTION private.guard_settlements();

ALTER TABLE public.group_events DROP CONSTRAINT group_events_kind_check;
ALTER TABLE public.group_events ADD CONSTRAINT group_events_kind_check CHECK (kind IN ('group_created', 'member_added', 'member_rejoined', 'member_left', 'member_removed', 'member_account_deleted', 'ownership_transferred', 'expense_created', 'expense_updated', 'expense_deleted', 'settlement_recorded', 'settlement_voided'));

-- Balances from the tables of record. No authorization: callers check it.
CREATE FUNCTION private.group_balances(p_group_id uuid)
RETURNS TABLE(user_id uuid, paid_cents bigint, owed_cents bigint, settled_out_cents bigint,
              settled_in_cents bigint, net_cents bigint)
LANGUAGE sql STABLE
SET search_path = ''
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
REVOKE ALL ON FUNCTION private.group_balances(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_group_balances(p_group_id uuid)
RETURNS TABLE(user_id uuid, paid_cents bigint, owed_cents bigint, settled_out_cents bigint,
              settled_in_cents bigint, net_cents bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
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
REVOKE ALL ON FUNCTION public.get_group_balances(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_group_balances(uuid) TO authenticated;

CREATE FUNCTION public.record_settlement(
  p_group_id uuid,
  p_from_user uuid,
  p_to_user uuid,
  p_amount_cents bigint,
  p_settled_on date,
  p_note text DEFAULT NULL,
  p_client_request_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
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
REVOKE ALL ON FUNCTION public.record_settlement(uuid, uuid, uuid, bigint, date, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_settlement(uuid, uuid, uuid, bigint, date, text, uuid) TO authenticated;

CREATE FUNCTION public.void_settlement(p_settlement_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
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
REVOKE ALL ON FUNCTION public.void_settlement(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.void_settlement(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_group(p_group_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
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
