-- M20: manual expense creation (create_equal_split_expense_v2 over the
-- core) holds its members: a removal or leave racing it either commits first
-- (creation refused) or waits (the expense stands). Before M20 the creation
-- checked membership unlocked and could record an expense for someone removed
-- a moment earlier. Fixture: G1 owner A, members B, E.
CREATE EXTENSION dblink SCHEMA tests;

CREATE FUNCTION tests.u(letter text) RETURNS uuid LANGUAGE sql IMMUTABLE
  AS $f$ SELECT ('00000000-0000-4000-8000-00000000000' || letter)::uuid $f$;
CREATE FUNCTION tests.conn() RETURNS text LANGUAGE sql AS $f$
  SELECT format('host=127.0.0.1 port=%s dbname=%s user=cluster_admin', current_setting('port'), current_database())
$f$;
CREATE FUNCTION tests.as_user(name text, letter text, sql text, wait boolean) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM tests.dblink_connect(name, tests.conn());
  PERFORM tests.dblink_exec(name, $s$SET lock_timeout = '20s'$s$);
  PERFORM tests.dblink_exec(name, 'BEGIN');
  PERFORM tests.dblink_exec(name, format($q$DO $d$BEGIN PERFORM tests.login(%L); END$d$$q$, tests.u(letter)));
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
CREATE FUNCTION tests.v2(payer text) RETURNS text LANGUAGE sql AS $f$
  SELECT format($s$public.create_equal_split_expense_v2('10000000-0000-4000-8000-000000000001', 'Race', 900, current_date, %L, %L)$s$,
    tests.u(payer), ARRAY[tests.u('a'), tests.u('b'), tests.u('e')])
$f$;
CREATE FUNCTION tests.race_expenses() RETURNS bigint LANGUAGE sql AS $f$
  SELECT count(*) FROM public.expenses WHERE description = 'Race'
$f$;
CREATE FUNCTION tests.readd_e() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM tests.as_user('readd', 'a', $s$public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', 'eve@example.test')$s$, true);
  PERFORM tests.finish('readd');
END $f$;

-- Removal first: the creation waits, then is refused.
SELECT tests.as_user('rm', 'a', $s$public.remove_group_member('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000e')$s$, true);
SELECT tests.as_user('mk', 'b', tests.v2('b'), false);
SELECT tests.assert(tests.blocked('mk'), 'a manual expense waits for a concurrent removal of a participant');
SELECT tests.finish('rm');
SELECT tests.assert_eq(tests.outcome('mk'), 'invalid_participants', 'and is refused once the removal commits');
SELECT tests.assert_eq(tests.race_expenses(), 0::bigint, 'no expense involves the removed member');
SELECT tests.readd_e();

-- Creation first: the removal waits; the expense stands.
SELECT tests.as_user('mk2', 'b', tests.v2('b'), true);
SELECT tests.as_user('rm2', 'a', $s$public.remove_group_member('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000e')$s$, false);
SELECT tests.assert(tests.blocked('rm2'), 'a removal waits for an in-flight manual expense involving that member');
SELECT tests.finish('mk2');
SELECT tests.assert_eq(tests.outcome('rm2'), 'ok', 'and then applies');
SELECT tests.assert_eq(tests.race_expenses(), 1::bigint, 'the expense created first stands');
SELECT tests.readd_e();

-- The payer leaving first: refused as an invalid payer.
SELECT tests.as_user('lv', 'e', $s$public.leave_group('10000000-0000-4000-8000-000000000001')$s$, true);
SELECT tests.as_user('mk3', 'b', tests.v2('e'), false);
SELECT tests.assert(tests.blocked('mk3'), 'a manual expense waits for its payer leaving');
SELECT tests.finish('lv');
SELECT tests.assert_eq(tests.outcome('mk3'), 'invalid_payer', 'and is refused once they have left');
SELECT tests.assert_eq(tests.race_expenses(), 1::bigint, 'nothing more was recorded');
