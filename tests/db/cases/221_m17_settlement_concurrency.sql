-- M17 concurrency: two settlements of the same debt, and two retries of the
-- same request, run in real concurrent sessions (dblink). The group row lock
-- serialises them, so together they can never over-settle or double-write.
-- Fixture: in G1, B owes 43.33 (4333 cents) to A.
CREATE EXTENSION dblink SCHEMA tests;

CREATE FUNCTION tests.conn() RETURNS text LANGUAGE sql AS $f$
  SELECT format('host=127.0.0.1 port=%s dbname=%s user=cluster_admin', current_setting('port'), current_database())
$f$;
-- Opens a session as B (authenticated) with a transaction, runs `sql` in it
-- synchronously when `wait`, otherwise sends it and returns at once.
CREATE FUNCTION tests.as_b(name text, sql text, wait boolean) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM tests.dblink_connect(name, tests.conn());
  PERFORM tests.dblink_exec(name, $s$SET lock_timeout = '20s'$s$);
  PERFORM tests.dblink_exec(name, 'BEGIN');
  PERFORM tests.dblink_exec(name, $q$DO $d$BEGIN PERFORM tests.login('00000000-0000-4000-8000-00000000000b'); END$d$$q$);
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
CREATE FUNCTION tests.b_net() RETURNS bigint LANGUAGE sql AS $f$
  SELECT net_cents FROM private.group_balances('10000000-0000-4000-8000-000000000001')
   WHERE user_id = '00000000-0000-4000-8000-00000000000b'
$f$;

-- Two 30.00 payments of a 43.33 debt: the second waits, then is refused.
SELECT tests.as_b('first', $$public.record_settlement('10000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000a', 3000, current_date)$$, true);
SELECT tests.as_b('second', $$public.record_settlement('10000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000a', 3000, current_date)$$, false);
SELECT tests.assert(tests.blocked('second'), 'a concurrent settlement in the same group waits for the first');
SELECT tests.finish('first');
SELECT tests.assert_eq(tests.outcome('second'), 'exceeds_balance', 'then sees the reduced debt and is refused');
SELECT tests.assert_eq(tests.b_net(), -1333::bigint, 'exactly one payment was applied');

-- A retried request racing itself writes once.
SELECT tests.as_b('try1', $$public.record_settlement('10000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000a', 1000, current_date, NULL,
  'bbbbbbbb-0000-4000-8000-000000000001')$$, true);
SELECT tests.as_b('try2', $$public.record_settlement('10000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000a', 1000, current_date, NULL,
  'bbbbbbbb-0000-4000-8000-000000000001')$$, false);
SELECT tests.assert(tests.blocked('try2'), 'a concurrent retry waits for the original');
SELECT tests.finish('try1');
SELECT tests.assert_eq(tests.outcome('try2'), 'ok', 'then returns the existing settlement');
SELECT tests.assert_eq((SELECT count(*) FROM public.settlements WHERE client_request_id = 'bbbbbbbb-0000-4000-8000-000000000001'),
  1::bigint, 'written once');
SELECT tests.assert_eq(tests.b_net(), -333::bigint, 'and applied once');

-- A new expense in the group waits for an in-flight settlement (foreign-key
-- lock on the group row), so balances cannot shift under the check.
SELECT tests.as_b('pay', $$public.record_settlement('10000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000a', 333, current_date)$$, true);
SELECT tests.as_b('spend', $$public.create_equal_split_expense_v2('10000000-0000-4000-8000-000000000001', 'Taxi', 900,
  current_date, '00000000-0000-4000-8000-00000000000b', ARRAY['00000000-0000-4000-8000-00000000000a'::uuid, '00000000-0000-4000-8000-00000000000b'::uuid])$$, false);
SELECT tests.assert(tests.blocked('spend'), 'expense creation waits for the settlement');
SELECT tests.finish('pay');
SELECT tests.assert_eq(tests.outcome('spend'), 'ok', 'and then proceeds');
SELECT tests.assert_eq((SELECT sum(net_cents) FROM private.group_balances('10000000-0000-4000-8000-000000000001')), 0::numeric,
  'the group still nets to zero');

-- An expense edit in flight also serialises with a settlement: the edit's
-- activity event takes a key-share lock on the group row. Edit first (the
-- taxi drops from 9.00 to 1.00, so Bob is owed 0.50 instead of 4.50): Eve's
-- 3.33 payment to Bob waits, then sees the edited balances and is refused.
CREATE FUNCTION tests.as_user(name text, uid text, sql text, wait boolean) RETURNS void LANGUAGE plpgsql AS $f$
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
SELECT tests.as_user('edit', '00000000-0000-4000-8000-00000000000b',
  (SELECT format($s$public.update_equal_split_expense(%L, %L, 'Taxi', 100, current_date,
     '00000000-0000-4000-8000-00000000000b', ARRAY['00000000-0000-4000-8000-00000000000a'::uuid, '00000000-0000-4000-8000-00000000000b'::uuid])$s$,
     id, updated_at) FROM public.expenses WHERE description = 'Taxi'), true);
SELECT tests.as_user('late', '00000000-0000-4000-8000-00000000000e',
  $$public.record_settlement('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000e',
    '00000000-0000-4000-8000-00000000000b', 333, current_date)$$, false);
SELECT tests.assert(tests.blocked('late'), 'a settlement waits for an in-flight expense edit in the same group');
SELECT tests.finish('edit');
SELECT tests.assert_eq(tests.outcome('late'), 'exceeds_balance', 'then checks the edited balances, not the stale ones');
SELECT tests.assert_eq((SELECT sum(net_cents) FROM private.group_balances('10000000-0000-4000-8000-000000000001')), 0::numeric,
  'the group still nets to zero after the edit');
