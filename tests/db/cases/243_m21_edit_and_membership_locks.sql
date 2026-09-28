-- M21: expense edit/delete and settlements serialise with membership changes
-- (dblink, real concurrent sessions). Fixture: G1 owner A, members B, E;
-- X1 (A paid/created, split A, B), X2 (B paid/created, split A, B, E).
-- Before M21 each "waits" assertion below failed: the later action ran on
-- the stale premise.
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
CREATE FUNCTION tests.x(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT ('20000000-0000-4000-8000-00000000000' || n)::uuid $f$;
CREATE FUNCTION tests.at(n int) RETURNS text LANGUAGE sql AS $f$ SELECT updated_at::text FROM public.expenses WHERE id = tests.x(n) $f$;
CREATE FUNCTION tests.edit(n int, people text[]) RETURNS text LANGUAGE sql AS $f$
  SELECT format($s$public.update_equal_split_expense(%L, %L, 'Edited', 10000, current_date, %L, %L)$s$,
    tests.x(n), tests.at(n), (SELECT paid_by FROM public.expenses WHERE id = tests.x(n)),
    (SELECT array_agg(tests.u(p)) FROM unnest(people) p))
$f$;
CREATE FUNCTION tests.remove(letter text) RETURNS text LANGUAGE sql AS $f$
  SELECT format($s$public.remove_group_member('10000000-0000-4000-8000-000000000001', %L)$s$, tests.u(letter))
$f$;
CREATE FUNCTION tests.readd(letter text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM tests.as_user('readd', 'a', format($s$public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', %L)$s$,
    (SELECT email FROM auth.users WHERE id = tests.u(letter))), true);
  PERFORM tests.finish('readd');
END $f$;
CREATE FUNCTION tests.in_x(n int, letter text) RETURNS boolean LANGUAGE sql AS $f$
  SELECT EXISTS (SELECT 1 FROM public.expense_splits WHERE expense_id = tests.x(n) AND user_id = tests.u(letter))
$f$;
CREATE FUNCTION tests.settle() RETURNS text LANGUAGE sql AS $f$
  SELECT $s$public.record_settlement('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000b',
    '00000000-0000-4000-8000-00000000000a', 1000, current_date)$s$
$f$;
CREATE FUNCTION tests.settlements() RETURNS bigint LANGUAGE sql AS $f$ SELECT count(*) FROM public.settlements $f$;

-- Edit adding a member vs that member's removal: removal first -> refused.
SELECT tests.as_user('rm', 'a', tests.remove('e'), true);
SELECT tests.as_user('ed', 'a', tests.edit(1, ARRAY['a','b','e']), false);
SELECT tests.assert(tests.blocked('ed'), 'an edit adding a participant waits for that participant''s removal');
SELECT tests.finish('rm');
SELECT tests.assert_eq(tests.outcome('ed'), 'invalid_participants', 'and is refused once the removal commits');
SELECT tests.assert(NOT tests.in_x(1, 'e'), 'the removed member was not added');
SELECT tests.readd('e');

-- Edit first -> the removal waits; the edit stands.
SELECT tests.as_user('ed2', 'a', tests.edit(1, ARRAY['a','b','e']), true);
SELECT tests.as_user('rm2', 'a', tests.remove('e'), false);
SELECT tests.assert(tests.blocked('rm2'), 'a removal waits for an in-flight edit that includes the member');
SELECT tests.finish('ed2');
SELECT tests.assert_eq(tests.outcome('rm2'), 'ok', 'and then applies');
SELECT tests.assert(tests.in_x(1, 'e'), 'the edit made first stands');
SELECT tests.readd('e');

-- Owner editing someone else's expense vs handing over ownership.
SELECT tests.as_user('tr', 'a', $s$public.transfer_group_ownership('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000e')$s$, true);
SELECT tests.as_user('ed3', 'a', tests.edit(2, ARRAY['a','b','e']), false);
SELECT tests.assert(tests.blocked('ed3'), 'an owner''s edit of another member''s expense waits for an ownership transfer');
SELECT tests.finish('tr');
SELECT tests.assert_eq(tests.outcome('ed3'), 'forbidden', 'and is refused once the editor is no longer the owner');
SELECT tests.as_user('back', 'e', $s$public.transfer_group_ownership('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000a')$s$, true);
SELECT tests.finish('back');

-- A creator deleting their expense vs their removal.
SELECT tests.as_user('rm3', 'a', tests.remove('b'), true);
SELECT tests.as_user('del', 'b', format($s$public.delete_expense(%L, %L)$s$, tests.x(2), tests.at(2)), false);
SELECT tests.assert(tests.blocked('del'), 'a delete by the creator waits for the creator''s removal');
SELECT tests.finish('rm3');
SELECT tests.assert_eq(tests.outcome('del'), 'not_found_or_forbidden', 'and is refused once they are no longer a member');
SELECT tests.assert((SELECT count(*) FROM public.expenses WHERE id = tests.x(2)) = 1, 'the expense is kept');
SELECT tests.readd('b');

-- A settlement recorded by a member vs their removal (removal first).
SELECT tests.as_user('rm4', 'a', tests.remove('b'), true);
SELECT tests.as_user('st', 'b', tests.settle(), false);
SELECT tests.assert(tests.blocked('st'), 'a settlement waits for the removal of the member recording it');
SELECT tests.finish('rm4');
SELECT tests.assert_eq(tests.outcome('st'), 'not_found_or_forbidden', 'and is refused once they are no longer a member');
SELECT tests.assert_eq(tests.settlements(), 0::bigint, 'nothing was recorded');
SELECT tests.readd('b');

-- Settlement first: the removal waits; the payment stands.
SELECT tests.as_user('st2', 'b', tests.settle(), true);
SELECT tests.as_user('rm5', 'a', tests.remove('b'), false);
SELECT tests.assert(tests.blocked('rm5'), 'a removal waits for an in-flight settlement by that member');
SELECT tests.finish('st2');
SELECT tests.assert_eq(tests.outcome('rm5'), 'ok', 'and then applies');
SELECT tests.assert_eq(tests.settlements(), 1::bigint, 'the payment recorded first stands');
