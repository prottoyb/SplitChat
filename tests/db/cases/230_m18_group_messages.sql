-- M18: group chat (ADR-0011). Fixture: G1 "Flat" owner A, members B, E;
-- G2 "Trip" owner D, members C, A. C and D are outsiders to G1.

CREATE FUNCTION tests.u(letter text) RETURNS uuid LANGUAGE sql IMMUTABLE
  AS $f$ SELECT ('00000000-0000-4000-8000-00000000000' || letter)::uuid $f$;
CREATE FUNCTION tests.g1() RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT '10000000-0000-4000-8000-000000000001'::uuid $f$;
CREATE FUNCTION tests.g2() RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT '10000000-0000-4000-8000-000000000002'::uuid $f$;
CREATE FUNCTION tests.rid(n int) RETURNS uuid LANGUAGE sql IMMUTABLE
  AS $f$ SELECT ('30000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $f$;
-- Unfiltered counts (definer), for assertions made as any role.
CREATE FUNCTION tests.message_count(g uuid) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT count(*) FROM public.group_messages WHERE group_id = g
$f$;
CREATE FUNCTION tests.event_count() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT count(*) FROM public.group_events
$f$;
-- Sends as `letter` in its own role context; returns the row id.
CREATE FUNCTION tests.send(letter text, g uuid, body text, rid uuid) RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE
  v_id bigint;
BEGIN
  PERFORM tests.login(tests.u(letter));
  SET LOCAL ROLE authenticated;
  SELECT (public.send_group_message(g, body, rid)).id INTO v_id;
  RESET ROLE;
  RETURN v_id;
END $f$;
-- Rows visible to `letter` through RLS.
CREATE FUNCTION tests.visible(letter text, g uuid) RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE
  v_n bigint;
BEGIN
  PERFORM tests.login(tests.u(letter));
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.group_messages WHERE group_id = g;
  RESET ROLE;
  RETURN v_n;
END $f$;

-- Surface --------------------------------------------------------------------
SELECT tests.assert((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.group_messages'::regclass), 'RLS on group_messages');
SELECT tests.assert(has_table_privilege('authenticated', 'public.group_messages', 'SELECT'), 'members can read messages (RLS-filtered)');
SELECT tests.assert(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                                 WHERE has_table_privilege('authenticated', 'public.group_messages', p)),
  'clients cannot write messages directly');
SELECT tests.assert(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
                                 WHERE has_table_privilege('anon', 'public.group_messages', p)),
  'anon has no access to messages');
SELECT tests.assert(has_function_privilege('authenticated', 'public.send_group_message(uuid,text,uuid)', 'EXECUTE'),
  'members can call send_group_message');
SELECT tests.assert(NOT has_function_privilege('anon', 'public.send_group_message(uuid,text,uuid)', 'EXECUTE'),
  'anon cannot call send_group_message');
SELECT tests.assert(EXISTS (SELECT 1 FROM pg_publication_tables
                             WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'group_messages'),
  'group_messages is published for Realtime');
SELECT tests.assert((SELECT prosecdef AND proconfig @> ARRAY['search_path=""']
                       FROM pg_proc WHERE oid = 'public.send_group_message(uuid,text,uuid)'::regprocedure),
  'send_group_message is SECURITY DEFINER with an empty search_path');

-- Send and read; group isolation -----------------------------------------------
BEGIN;
CREATE TEMP TABLE baseline AS SELECT tests.event_count() AS n;
GRANT SELECT ON baseline TO PUBLIC;
SELECT tests.send('b', tests.g1(), '  Rent is due Friday  ', tests.rid(1));
SELECT tests.send('c', tests.g2(), 'Fuel stop at 3', tests.rid(2));
SELECT tests.assert_eq((SELECT body FROM public.group_messages WHERE client_request_id = tests.rid(1)), 'Rent is due Friday',
  'the body is stored trimmed');
SELECT tests.assert_eq((SELECT sender_id FROM public.group_messages WHERE client_request_id = tests.rid(1)), tests.u('b'),
  'the sender is the caller');
SELECT tests.assert_eq(tests.visible('a', tests.g1()), 1::bigint, 'another member of the group reads it');
SELECT tests.assert_eq(tests.visible('c', tests.g1()), 0::bigint, 'an outsider reads nothing of the group');
SELECT tests.assert_eq(tests.visible('b', tests.g2()), 0::bigint, 'nothing crosses from another group');
SELECT tests.assert_eq(tests.visible('a', tests.g2()), 1::bigint, 'a member of both groups reads each group');
SELECT tests.login(tests.u('c'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.send_group_message(tests.g1(), 'hi', tests.rid(3))$$, 'P0001',
  'an outsider cannot send to the group', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.send_group_message(NULL, 'hi', tests.rid(3))$$, 'P0001',
  'a missing group is refused', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.send_group_message('10000000-0000-4000-8000-0000000000ff', 'hi', tests.rid(3))$$, 'P0001',
  'an unknown group is refused like a forbidden one', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.logout();
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.send_group_message(tests.g1(), 'hi', tests.rid(3))$$, 'P0001',
  'no identity, no sending', 'auth_required');
SELECT tests.assert_eq((SELECT count(*) FROM public.group_messages), 0::bigint, 'no identity, no reading');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT tests.assert_raises($$SELECT count(*) FROM public.group_messages$$, '42501', 'anon cannot select messages');
SELECT tests.assert_raises($$SELECT public.send_group_message(tests.g1(), 'hi', tests.rid(3))$$, '42501', 'anon cannot send');
RESET ROLE;
SELECT tests.assert_eq(tests.event_count(), (SELECT n FROM baseline), 'sending writes no group_events');
ROLLBACK;

-- Forged sender: no direct writes ----------------------------------------------
BEGIN;
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises(
  $$INSERT INTO public.group_messages (group_id, sender_id, body, client_request_id)
    VALUES (tests.g1(), tests.u('a'), 'I owe nothing', tests.rid(4))$$,
  '42501', 'a direct insert (forged sender) is denied');
RESET ROLE;
ROLLBACK;

-- Body and request-id validation -------------------------------------------------
BEGIN;
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.send_group_message(tests.g1(), '', tests.rid(5))$$, 'P0001', 'a blank body is refused', 'invalid_body');
SELECT tests.assert_raises($$SELECT public.send_group_message(tests.g1(), E'  \n\t ', tests.rid(5))$$, 'P0001', 'a whitespace-only body is refused', 'invalid_body');
SELECT tests.assert_raises($$SELECT public.send_group_message(tests.g1(), NULL, tests.rid(5))$$, 'P0001', 'a null body is refused', 'invalid_body');
SELECT tests.assert_raises($$SELECT public.send_group_message(tests.g1(), repeat('x', 2001), tests.rid(5))$$, 'P0001', '2001 characters are refused', 'invalid_body');
SELECT tests.assert_raises($$SELECT public.send_group_message(tests.g1(), E'bell\x07', tests.rid(5))$$, 'P0001', 'control characters are refused', 'invalid_body');
SELECT tests.assert_raises($$SELECT public.send_group_message(tests.g1(), 'hi', NULL)$$, 'P0001', 'a missing request id is refused', 'invalid_request');
SELECT tests.assert_ok($$SELECT public.send_group_message(tests.g1(), repeat('x', 2000), tests.rid(6))$$, '2000 characters are accepted');
SELECT tests.assert_ok($$SELECT public.send_group_message(tests.g1(), E'line one\nline two\tindented', tests.rid(7))$$, 'newlines and tabs inside are accepted');
RESET ROLE;
ROLLBACK;

-- Idempotency ------------------------------------------------------------------------
BEGIN;
CREATE TEMP TABLE first_send AS SELECT tests.send('b', tests.g1(), 'Dinner at 7?', tests.rid(8)) AS id;
GRANT SELECT ON first_send TO PUBLIC;
SELECT tests.assert_eq(tests.send('b', tests.g1(), ' Dinner at 7? ', tests.rid(8)), (SELECT id FROM first_send),
  'a retry with the same request id and body returns the same message');
SELECT tests.assert_eq(tests.message_count(tests.g1()), 1::bigint, 'and records it once');
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.send_group_message(tests.g1(), 'Dinner at 8?', tests.rid(8))$$, 'P0001',
  'the same request id with a different body is refused', 'duplicate_request');
RESET ROLE;
SELECT tests.assert(tests.send('a', tests.g1(), 'Dinner at 7?', tests.rid(8)) <> (SELECT id FROM first_send),
  'request ids are per sender');
ROLLBACK;

-- Deterministic order and keyset paging over tied timestamps ---------------------
BEGIN;
SET LOCAL ROLE cluster_admin;
INSERT INTO public.group_messages (group_id, sender_id, body, client_request_id, created_at)
SELECT tests.g1(), tests.u('a'), 'm' || n, tests.rid(100 + n), timestamptz '2026-09-28 10:00:00+00'
  FROM generate_series(1, 5) n;
RESET ROLE;
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE page1 AS
SELECT id, created_at FROM public.group_messages WHERE group_id = tests.g1()
 ORDER BY created_at DESC, id DESC LIMIT 2;
CREATE TEMP TABLE page2 AS
SELECT id FROM public.group_messages
 WHERE group_id = tests.g1()
   AND (created_at, id) < (SELECT created_at, id FROM page1 ORDER BY created_at, id LIMIT 1)
 ORDER BY created_at DESC, id DESC;
SELECT tests.assert_eq((SELECT count(*) FROM page2), 3::bigint, 'the next page holds exactly the rest');
SELECT tests.assert(NOT EXISTS (SELECT 1 FROM page1 JOIN page2 USING (id)), 'pages do not overlap');
SELECT tests.assert_eq((SELECT array_agg(id ORDER BY id DESC) FROM page1) || (SELECT array_agg(id ORDER BY id DESC) FROM page2),
  (SELECT array_agg(id ORDER BY created_at DESC, id DESC) FROM public.group_messages WHERE group_id = tests.g1()),
  'ties on created_at are ordered by id');
RESET ROLE;
ROLLBACK;

-- Rate limit (retries are not counted) -------------------------------------------------
-- A is in both groups: the limit counts across them.
BEGIN;
SELECT tests.send('a', tests.g1(), 'msg ' || n, tests.rid(200 + n)) FROM generate_series(1, 20) n;
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.send_group_message(tests.g2(), 'one more', tests.rid(300))$$, 'P0001',
  'the 21st message in a minute is refused, in any group', 'rate_limited');
SELECT tests.assert_ok($$SELECT public.send_group_message(tests.g1(), 'msg 3', tests.rid(203))$$,
  'a retry of a sent message is not refused by the limit');
RESET ROLE;
SELECT tests.assert_eq(tests.message_count(tests.g1()), 20::bigint, 'the retry wrote nothing');
SELECT tests.assert_ok($$SELECT tests.send('b', tests.g1(), 'still fine', tests.rid(301))$$, 'the limit is per sender');
ROLLBACK;

-- Former members: left, removed, account deleted; rejoin sees history ---------------
BEGIN;
SELECT tests.send('b', tests.g1(), 'before leaving', tests.rid(400));
SELECT tests.send('e', tests.g1(), 'hello from Eve', tests.rid(401));
-- B leaves.
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
SELECT public.leave_group(tests.g1());
SELECT tests.assert_raises($$SELECT public.send_group_message(tests.g1(), 'after leaving', tests.rid(402))$$, 'P0001',
  'a member who left cannot send', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.assert_eq(tests.visible('b', tests.g1()), 0::bigint, 'a member who left reads nothing, not even earlier history');
SELECT tests.send('a', tests.g1(), 'while Bob is away', tests.rid(403));
-- A adds B back: the whole history is visible again.
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
SELECT public.add_group_member_by_email(tests.g1(), 'bob@example.test');
RESET ROLE;
SELECT tests.assert_eq(tests.visible('b', tests.g1()), 3::bigint, 'a member added back reads the whole history');
-- A removes B.
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
SELECT public.remove_group_member(tests.g1(), tests.u('b'));
RESET ROLE;
SELECT tests.assert_eq(tests.visible('b', tests.g1()), 0::bigint, 'a removed member reads nothing');
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.send_group_message(tests.g1(), 'let me in', tests.rid(404))$$, 'P0001',
  'a removed member cannot send', 'not_found_or_forbidden');
RESET ROLE;
-- E deletes their account: messages stay, E is named by the tombstone.
DELETE FROM auth.users WHERE id = tests.u('e');
SELECT tests.assert_eq(tests.message_count(tests.g1()), 3::bigint, 'messages survive account deletion');
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq((SELECT display_name FROM public.get_ledger_identities(tests.g1()) WHERE user_id = tests.u('e')),
  'Deleted user', 'a deleted sender is named by the tombstone');
SELECT tests.assert_eq((SELECT display_name FROM public.get_ledger_identities(tests.g1()) WHERE user_id = tests.u('b')),
  'Bob', 'a former sender stays nameable');
RESET ROLE;
SELECT tests.login(tests.u('c'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT * FROM public.get_ledger_identities(tests.g1())$$, 'P0001',
  'outsiders still cannot list identities', 'not_found_or_forbidden');
RESET ROLE;
ROLLBACK;

-- Immutability and the solo-group cascade --------------------------------------------
BEGIN;
SELECT tests.send('a', tests.g1(), 'original', tests.rid(500));
SELECT tests.assert_raises($$UPDATE public.group_messages SET body = 'edited' WHERE client_request_id = tests.rid(500)$$,
  'P0001', 'messages cannot be edited, even by the table owner', 'group_messages_immutable');
SELECT tests.assert_raises($$DELETE FROM public.group_messages WHERE client_request_id = tests.rid(500)$$,
  'P0001', 'messages cannot be deleted on their own', 'group_messages_immutable');
-- A solo group with messages can still be deleted (the cascade).
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
INSERT INTO public.groups (name, created_by) VALUES ('Solo chat', tests.u('a'));
CREATE TEMP TABLE solo AS SELECT id FROM public.groups WHERE name = 'Solo chat';
SELECT public.send_group_message((SELECT id FROM solo), 'note to self', tests.rid(501));
SELECT tests.assert_ok($$SELECT public.delete_group((SELECT id FROM solo))$$,
  'a solo group with messages can be deleted');
RESET ROLE;
SELECT tests.assert_eq(tests.message_count((SELECT id FROM solo)), 0::bigint, 'its messages go with it');
ROLLBACK;
