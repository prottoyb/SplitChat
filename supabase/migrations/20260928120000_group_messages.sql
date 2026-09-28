SET LOCAL lock_timeout = '5s';

-- M18: group chat (ADR-0011, conditions 1-15).
--
--  - public.group_messages: immutable, group-scoped chat messages. Clients
--    can only SELECT, only for groups they are an active member of (RLS).
--    Former members (left, removed, deleted account) see nothing; a member
--    added back sees the whole history.
--  - send_group_message: the only write path. Authorization, validation,
--    then the group row FOR KEY SHARE (delete_group's lock order), the
--    caller's active membership row FOR SHARE (serialises with leave,
--    remove and account deletion) and a per-sender advisory lock;
--    idempotent on (group, sender, client_request_id); rate limited per
--    sender (20 a minute, 1000 a day, across groups; retries not counted).
--  - A guard trigger refuses UPDATE, and DELETE unless the group row is
--    already gone (the solo-group delete_group cascade).
--  - Messages write no group_events (ADR-0011: events stay ledger and
--    membership audit).
--  - get_ledger_identities also names former members who sent a message in
--    the group (a message references its sender like a ledger row), so
--    former and deleted senders stay nameable. Former members with no
--    record at all stay undisclosed (G1).
--  - Realtime: the table joins the supabase_realtime publication (Postgres
--    Changes, RLS evaluated per subscriber).
--
-- Rollback: remove the table from the publication, drop the RPC, the
-- trigger function and the table, restore get_ledger_identities from M16.
-- Once production has messages this discards chat history: fix-forward,
-- and any rollback needs its own approval.

CREATE TABLE public.group_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES public.groups (id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE RESTRICT,
  body text NOT NULL,
  client_request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT group_messages_body_check CHECK (
    char_length(body) BETWEEN 1 AND 2000
    AND body = btrim(body, E' \t\n\r')
    AND body !~ '[\x01-\x08\x0B-\x1F\x7F]'
  ),
  CONSTRAINT group_messages_request_unique UNIQUE (group_id, sender_id, client_request_id)
);
CREATE INDEX group_messages_group_idx ON public.group_messages (group_id, created_at DESC, id DESC);
CREATE INDEX group_messages_sender_idx ON public.group_messages (sender_id, created_at DESC);

ALTER TABLE public.group_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.group_messages FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.group_messages TO authenticated;
CREATE POLICY "Members can read group messages" ON public.group_messages
  FOR SELECT TO authenticated
  USING (group_id IN (SELECT private.my_active_group_ids()));

-- Immutability (condition 5).
CREATE FUNCTION private.guard_group_messages() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.groups g WHERE g.id = OLD.group_id) THEN
    RETURN OLD;  -- the group itself is being deleted (cascade)
  END IF;
  RAISE EXCEPTION 'group_messages_immutable' USING ERRCODE = 'P0001';
END
$$;
REVOKE ALL ON FUNCTION private.guard_group_messages() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER group_messages_immutable
  BEFORE UPDATE OR DELETE ON public.group_messages
  FOR EACH ROW EXECUTE FUNCTION private.guard_group_messages();

CREATE FUNCTION public.send_group_message(p_group_id uuid, p_body text, p_client_request_id uuid)
RETURNS public.group_messages
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
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
REVOKE ALL ON FUNCTION public.send_group_message(uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.send_group_message(uuid, text, uuid) TO authenticated;

-- Former senders stay nameable (condition 6, amended to keep G1).
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

-- Realtime (Postgres Changes; condition 8).
ALTER PUBLICATION supabase_realtime ADD TABLE public.group_messages;
