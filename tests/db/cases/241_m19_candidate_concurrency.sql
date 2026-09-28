-- M19 concurrency (dblink, real concurrent sessions), ADR-0012 condition 12:
-- approve x approve, approve x edit, approve x removal (both orders),
-- approve x leave, approve x ownership transfer, approve x solo delete_group.
-- Fixture: G1 owner A, members B, E.
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
-- A committed message from `letter` in `g` with a complete candidate:
-- 30.00 paid by `payer`, split between `people`. Returns the candidate id.
CREATE FUNCTION tests.new_candidate(letter text, g uuid, payer text, people text[]) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE
  v_msg bigint;
  v_id uuid;
BEGIN
  PERFORM tests.login(tests.u(letter));
  INSERT INTO public.group_messages (group_id, sender_id, body, client_request_id)
  VALUES (g, tests.u(letter), 'Dinner 30', gen_random_uuid()) RETURNING id INTO v_msg;
  INSERT INTO public.expense_candidates (group_id, message_id, proposed_by, source, interpreter_version,
    description, amount_cents, expense_date, paid_by, participant_ids)
  VALUES (g, v_msg, tests.u(letter), 'natural', 'deterministic-1', 'Dinner', 3000, current_date, tests.u(payer),
    (SELECT array_agg(tests.u(p)) FROM unnest(people) p))
  RETURNING id INTO v_id;
  RETURN v_id;
END $f$;
CREATE TABLE tests.ids (name text PRIMARY KEY, id uuid);
GRANT ALL ON tests.ids TO PUBLIC;
CREATE FUNCTION tests.id(n text) RETURNS uuid LANGUAGE sql AS $f$ SELECT id FROM tests.ids WHERE name = n $f$;
CREATE FUNCTION tests.status(n text) RETURNS text LANGUAGE sql AS $f$
  SELECT status FROM public.expense_candidates WHERE id = tests.id(n)
$f$;
CREATE FUNCTION tests.expenses_for(n text) RETURNS bigint LANGUAGE sql AS $f$
  SELECT count(*) FROM public.group_events WHERE kind = 'expense_created' AND payload ->> 'candidate_id' = tests.id(n)::text
$f$;
CREATE FUNCTION tests.readd(letter text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM tests.as_user('readd', 'a', format($s$public.add_group_member_by_email('10000000-0000-4000-8000-000000000001', %L)$s$,
    (SELECT email FROM auth.users WHERE id = tests.u(letter))), true);
  PERFORM tests.finish('readd');
END $f$;

-- approve x approve: one expense.
INSERT INTO tests.ids VALUES ('c1', tests.new_candidate('b', '10000000-0000-4000-8000-000000000001', 'b', ARRAY['a','b','e']));
SELECT tests.as_user('a1', 'b', format('public.approve_expense_candidate(%L, 1)', tests.id('c1')), true);
SELECT tests.as_user('a2', 'a', format('public.approve_expense_candidate(%L, 1)', tests.id('c1')), false);
SELECT tests.assert(tests.blocked('a2'), 'a second approval waits for the first');
SELECT tests.finish('a1');
SELECT tests.assert_eq(tests.outcome('a2'), 'ok', 'and then returns the same expense');
SELECT tests.assert_eq(tests.expenses_for('c1'), 1::bigint, 'two concurrent approvals create one expense');

-- approve x edit: the later one sees the decision.
INSERT INTO tests.ids VALUES ('c2', tests.new_candidate('b', '10000000-0000-4000-8000-000000000001', 'b', ARRAY['a','b']));
SELECT tests.as_user('ap', 'b', format('public.approve_expense_candidate(%L, 1)', tests.id('c2')), true);
SELECT tests.as_user('ed', 'b', format($s$public.update_expense_candidate(%L, 1, 'Changed', 9900, current_date, %L, %L)$s$,
  tests.id('c2'), tests.u('b'), ARRAY[tests.u('a'), tests.u('b')]), false);
SELECT tests.assert(tests.blocked('ed'), 'an edit waits for an in-flight approval');
SELECT tests.finish('ap');
SELECT tests.assert_eq(tests.outcome('ed'), 'candidate_decided', 'and is refused once it is approved');
SELECT tests.assert_eq((SELECT amount_cents FROM public.expense_candidates WHERE id = tests.id('c2')), 3000::bigint, 'the approved draft is unchanged');

-- edit x approve: the approval of the reviewed version is refused as stale.
INSERT INTO tests.ids VALUES ('c3', tests.new_candidate('b', '10000000-0000-4000-8000-000000000001', 'b', ARRAY['a','b']));
SELECT tests.as_user('ed2', 'b', format($s$public.update_expense_candidate(%L, 1, 'Changed', 9900, current_date, %L, %L)$s$,
  tests.id('c3'), tests.u('b'), ARRAY[tests.u('a'), tests.u('b')]), true);
SELECT tests.as_user('ap2', 'a', format('public.approve_expense_candidate(%L, 1)', tests.id('c3')), false);
SELECT tests.assert(tests.blocked('ap2'), 'an approval waits for an in-flight edit');
SELECT tests.finish('ed2');
SELECT tests.assert_eq(tests.outcome('ap2'), 'stale_candidate', 'and refuses the version it did not review');
SELECT tests.assert_eq(tests.status('c3'), 'proposed', 'nothing was approved');

-- removal first, then approve: refused, still proposed.
INSERT INTO tests.ids VALUES ('c4', tests.new_candidate('b', '10000000-0000-4000-8000-000000000001', 'b', ARRAY['a','b','e']));
SELECT tests.as_user('rm', 'a', $s$public.remove_group_member('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000e')$s$, true);
SELECT tests.as_user('ap3', 'b', format('public.approve_expense_candidate(%L, 1)', tests.id('c4')), false);
SELECT tests.assert(tests.blocked('ap3'), 'an approval waits for a concurrent removal of a participant');
SELECT tests.finish('rm');
SELECT tests.assert_eq(tests.outcome('ap3'), 'invalid_participants', 'and is refused once the removal commits');
SELECT tests.assert_eq(tests.status('c4'), 'proposed', 'the candidate stays proposed');
SELECT tests.readd('e');

-- approve first, then removal: the removal waits; the expense stands.
INSERT INTO tests.ids VALUES ('c5', tests.new_candidate('b', '10000000-0000-4000-8000-000000000001', 'b', ARRAY['a','b','e']));
SELECT tests.as_user('ap4', 'b', format('public.approve_expense_candidate(%L, 1)', tests.id('c5')), true);
SELECT tests.as_user('rm2', 'a', $s$public.remove_group_member('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000e')$s$, false);
SELECT tests.assert(tests.blocked('rm2'), 'a removal of a participant waits for an in-flight approval');
SELECT tests.finish('ap4');
SELECT tests.assert_eq(tests.outcome('rm2'), 'ok', 'and then applies');
SELECT tests.assert_eq(tests.expenses_for('c5'), 1::bigint, 'the approved expense stands');
SELECT tests.readd('e');

-- approve x leave: the payer leaving first makes the draft unapprovable.
INSERT INTO tests.ids VALUES ('c6', tests.new_candidate('b', '10000000-0000-4000-8000-000000000001', 'e', ARRAY['a','b','e']));
SELECT tests.as_user('lv', 'e', $s$public.leave_group('10000000-0000-4000-8000-000000000001')$s$, true);
SELECT tests.as_user('ap5', 'b', format('public.approve_expense_candidate(%L, 1)', tests.id('c6')), false);
SELECT tests.assert(tests.blocked('ap5'), 'an approval waits for the payer leaving');
SELECT tests.finish('lv');
SELECT tests.assert_eq(tests.outcome('ap5'), 'invalid_payer', 'and is refused once they have left (the payer is checked first)');
SELECT tests.readd('e');

-- approve x transfer: an owner approving someone else's candidate while
-- handing over ownership; whichever commits first decides.
INSERT INTO tests.ids VALUES ('c7', tests.new_candidate('b', '10000000-0000-4000-8000-000000000001', 'b', ARRAY['a','b']));
SELECT tests.as_user('tr', 'a', $s$public.transfer_group_ownership('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000e')$s$, true);
SELECT tests.as_user('ap6', 'a', format('public.approve_expense_candidate(%L, 1)', tests.id('c7')), false);
SELECT tests.assert(tests.blocked('ap6'), 'an owner''s approval waits for a concurrent ownership transfer');
SELECT tests.finish('tr');
SELECT tests.assert_eq(tests.outcome('ap6'), 'forbidden', 'and is refused once the approver is no longer the owner');
SELECT tests.assert_eq(tests.status('c7'), 'proposed', 'the candidate stays proposed');

-- approve x delete_group (solo group; M15 allows deleting one whose history
-- involves only the owner): the deletion waits for the approval, then
-- removes the group with everything in it; nothing is left orphaned.
DO $d$
DECLARE
  v_group uuid;
BEGIN
  PERFORM tests.login(tests.u('d'));
  INSERT INTO public.groups (name, created_by) VALUES ('Solo race', tests.u('d')) RETURNING id INTO v_group;
  INSERT INTO tests.ids VALUES ('solo', v_group);
  INSERT INTO tests.ids VALUES ('c8', tests.new_candidate('d', v_group, 'd', ARRAY['d']));
END $d$;
SELECT tests.as_user('ap7', 'd', format('public.approve_expense_candidate(%L, 1)', tests.id('c8')), true);
SELECT tests.as_user('del', 'd', format('public.delete_group(%L)', tests.id('solo')), false);
SELECT tests.assert(tests.blocked('del'), 'deleting a solo group waits for an in-flight approval in it');
SELECT tests.finish('ap7');
SELECT tests.assert_eq(tests.outcome('del'), 'ok', 'and then deletes the solo group');
SELECT tests.assert_eq((SELECT count(*) FROM public.expense_candidates WHERE group_id = tests.id('solo'))
                     + (SELECT count(*) FROM public.expenses WHERE group_id = tests.id('solo'))
                     + (SELECT count(*) FROM public.group_messages WHERE group_id = tests.id('solo')), 0::bigint,
  'with its candidate, expense and messages: nothing orphaned');
