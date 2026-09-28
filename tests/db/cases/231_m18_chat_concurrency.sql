-- M18 concurrency (dblink, real concurrent sessions):
--  - a send racing a removal waits for it and is then refused;
--  - a removal racing an in-flight send waits for the send;
--  - concurrent sends by one sender cannot pass the rate limit together.
-- Fixture: G1 owner A, members B, E.
CREATE EXTENSION dblink SCHEMA tests;

CREATE FUNCTION tests.conn() RETURNS text LANGUAGE sql AS $f$
  SELECT format('host=127.0.0.1 port=%s dbname=%s user=cluster_admin', current_setting('port'), current_database())
$f$;
-- Opens a session as `uid` (authenticated) in a transaction and runs `sql`:
-- synchronously when `wait`, otherwise sends it and returns at once.
CREATE FUNCTION tests.as_user(name text, uid uuid, sql text, wait boolean) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM tests.dblink_connect(name, tests.conn());
  PERFORM tests.dblink_exec(name, $s$SET lock_timeout = '20s'$s$);
  PERFORM tests.dblink_exec(name, 'BEGIN');
  PERFORM tests.dblink_exec(name, format($q$DO $d$BEGIN PERFORM tests.login(%L); END$d$$q$, uid));
  PERFORM tests.dblink_exec(name, 'SET LOCAL ROLE authenticated');
  IF wait THEN
    PERFORM tests.dblink_exec(name, format('DO $d$BEGIN PERFORM %s; END$d$', sql));
  ELSE
    PERFORM tests.dblink_send_query(name, format('SELECT (%s)::text', sql));
  END IF;
END $f$;
CREATE FUNCTION tests.outcome(name text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  v_out text;
BEGIN
  BEGIN
    PERFORM * FROM tests.dblink_get_result(name) AS r(x text);
    v_out := 'ok';
  EXCEPTION WHEN OTHERS THEN
    v_out := SQLERRM;
  END;
  PERFORM * FROM tests.dblink_get_result(name, false) AS r(x text);
  PERFORM tests.dblink_exec(name, CASE WHEN v_out = 'ok' THEN 'COMMIT' ELSE 'ROLLBACK' END, false);
  PERFORM tests.dblink_disconnect(name);
  RETURN v_out;
END $f$;
CREATE FUNCTION tests.finish(name text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM tests.dblink_exec(name, 'COMMIT');
  PERFORM tests.dblink_disconnect(name);
END $f$;
CREATE FUNCTION tests.blocked(name text) RETURNS boolean LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM pg_sleep(0.5);
  RETURN tests.dblink_is_busy(name) = 1;
END $f$;
CREATE FUNCTION tests.b_messages() RETURNS bigint LANGUAGE sql AS $f$
  SELECT count(*) FROM public.group_messages WHERE sender_id = '00000000-0000-4000-8000-00000000000b'
$f$;

-- A send racing a removal: the removal holds B's membership row; B's send
-- waits for it, then is refused.
SELECT tests.as_user('remove', '00000000-0000-4000-8000-00000000000a',
  $$public.remove_group_member('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b')$$, true);
SELECT tests.as_user('send', '00000000-0000-4000-8000-00000000000b',
  $$public.send_group_message('10000000-0000-4000-8000-000000000001', 'sneaking in', '30000000-0000-4000-8000-000000000001')$$, false);
SELECT tests.assert(tests.blocked('send'), 'a send waits for a concurrent removal of its sender');
SELECT tests.finish('remove');
SELECT tests.assert_eq(tests.outcome('send'), 'not_found_or_forbidden', 'and is refused once the removal commits');
SELECT tests.assert_eq(tests.b_messages(), 0::bigint, 'no message was written after the removal');

-- Put B back for the next scenarios.
SELECT tests.as_user('readd', '00000000-0000-4000-8000-00000000000a',
  $$public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'bob@example.test')$$, true);
SELECT tests.finish('readd');

-- A removal racing an in-flight send: the send holds B's membership row
-- FOR SHARE; the removal waits and applies after the send commits.
SELECT tests.as_user('send2', '00000000-0000-4000-8000-00000000000b',
  $$public.send_group_message('10000000-0000-4000-8000-000000000001', 'just in time', '30000000-0000-4000-8000-000000000002')$$, true);
SELECT tests.as_user('remove2', '00000000-0000-4000-8000-00000000000a',
  $$public.remove_group_member('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b')$$, false);
SELECT tests.assert(tests.blocked('remove2'), 'a removal waits for an in-flight send by that member');
SELECT tests.finish('send2');
SELECT tests.assert_eq(tests.outcome('remove2'), 'ok', 'and then applies');
SELECT tests.assert_eq(tests.b_messages(), 1::bigint, 'the send that won the race is kept');

SELECT tests.as_user('readd', '00000000-0000-4000-8000-00000000000a',
  $$public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'bob@example.test')$$, true);
SELECT tests.finish('readd');

-- Concurrent sends at the rate limit: B has 19 messages in the last minute
-- (18 more here); two concurrent sends cannot both pass the count.
INSERT INTO public.group_messages (group_id, sender_id, body, client_request_id)
SELECT '10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b', 'filler ' || n,
       ('30000000-0000-4000-8000-' || lpad((100 + n)::text, 12, '0'))::uuid
  FROM generate_series(1, 18) n;
SELECT tests.assert_eq(tests.b_messages(), 19::bigint, 'B is one message below the limit');
SELECT tests.as_user('s1', '00000000-0000-4000-8000-00000000000b',
  $$public.send_group_message('10000000-0000-4000-8000-000000000001', 'twentieth', '30000000-0000-4000-8000-000000000003')$$, true);
SELECT tests.as_user('s2', '00000000-0000-4000-8000-00000000000b',
  $$public.send_group_message('10000000-0000-4000-8000-000000000001', 'twenty-first', '30000000-0000-4000-8000-000000000004')$$, false);
SELECT tests.assert(tests.blocked('s2'), 'a second concurrent send by the same sender waits');
SELECT tests.finish('s1');
SELECT tests.assert_eq(tests.outcome('s2'), 'rate_limited', 'and is refused by the limit once the first commits');
SELECT tests.assert_eq(tests.b_messages(), 20::bigint, 'exactly the limit was written');
