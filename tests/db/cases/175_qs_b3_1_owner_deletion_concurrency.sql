-- QS-B3-1 regression: owner account deletion and add-by-email on the same
-- group, run concurrently in two real sessions (dblink to this disposable
-- database). Without the fix, "delete first" left a group with an active
-- member and no owner. Each case runs in its own database, so the setup is
-- committed.
CREATE EXTENSION dblink SCHEMA tests;

INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
  ('00000000-0000-4000-8000-0000000000b1', 'olga@example.test', '{"full_name":"Olga"}', now()),
  ('00000000-0000-4000-8000-0000000000b2', 'otto@example.test', '{"full_name":"Otto"}', now()),
  ('00000000-0000-4000-8000-0000000000b3', 'mina@example.test', '{"full_name":"Mina"}', now());
INSERT INTO public.groups (id, name, created_by) VALUES
  ('10000000-0000-4000-8000-0000000000b1', 'Olga solo', '00000000-0000-4000-8000-0000000000b1'),
  ('10000000-0000-4000-8000-0000000000b2', 'Otto solo', '00000000-0000-4000-8000-0000000000b2');

CREATE FUNCTION tests.conn() RETURNS text LANGUAGE sql AS $f$
  SELECT format('host=127.0.0.1 port=%s dbname=%s user=cluster_admin', current_setting('port'), current_database())
$f$;
-- Opens a named connection, runs `setup` statements synchronously inside a
-- transaction, then sends the single contested `sql` asynchronously.
CREATE FUNCTION tests.send(name text, setup text[], sql text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  v text;
BEGIN
  PERFORM tests.dblink_connect(name, tests.conn());
  PERFORM tests.dblink_exec(name, $s$SET lock_timeout = '20s'$s$);
  PERFORM tests.dblink_exec(name, 'BEGIN');
  FOREACH v IN ARRAY setup LOOP
    PERFORM tests.dblink_exec(name, v);
  END LOOP;
  PERFORM tests.dblink_send_query(name, sql);
END $f$;
-- Waits for the contested statement: returns 'ok' or its error message, then
-- ends the transaction (COMMIT on success) and disconnects.
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
  PERFORM * FROM tests.dblink_get_result(name, false) AS r(x text);  -- drain
  PERFORM tests.dblink_exec(name, CASE WHEN v_out = 'ok' THEN 'COMMIT' ELSE 'ROLLBACK' END, false);
  PERFORM tests.dblink_disconnect(name);
  RETURN v_out;
END $f$;
-- True while the named connection is still waiting (after a short pause).
CREATE FUNCTION tests.blocked(name text) RETURNS boolean LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM pg_sleep(0.5);
  RETURN tests.dblink_is_busy(name) = 1;
END $f$;

-- Deletion first: the trigger holds the group lock; the owner's own add
-- waits, then re-checks ownership and is refused.
SELECT tests.dblink_connect('del', tests.conn());
SELECT tests.dblink_exec('del', 'BEGIN');
SELECT tests.dblink_exec('del', $$SET LOCAL ROLE supabase_auth_admin$$);
SELECT tests.dblink_exec('del', $$DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000000000b1'$$);
SELECT tests.send('add',
  ARRAY[$q$DO $d$BEGIN PERFORM tests.login('00000000-0000-4000-8000-0000000000b1'); END$d$$q$, 'SET LOCAL ROLE authenticated'],
  $$SELECT result FROM public.add_group_member_by_email('10000000-0000-4000-8000-0000000000b1', 'mina@example.test')$$);
SELECT tests.assert(tests.blocked('add'), 'delete first: add-member waits for the deleting transaction');
SELECT tests.dblink_exec('del', 'COMMIT');
SELECT tests.dblink_disconnect('del');
SELECT tests.assert_eq(tests.outcome('add'), 'not_found_or_forbidden',
  'delete first: the add is refused once ownership is gone');
SELECT tests.assert_eq(
  (SELECT count(*) FROM public.group_members WHERE group_id = '10000000-0000-4000-8000-0000000000b1' AND left_at IS NULL),
  0::bigint, 'delete first: the group has no active member (a documented orphan), never a member without an owner');

-- Add first: the add holds the group lock; the deletion waits, then sees the
-- new member and is refused.
SELECT tests.dblink_connect('add2', tests.conn());
SELECT tests.dblink_exec('add2', 'BEGIN');
SELECT tests.dblink_exec('add2', $q$DO $d$BEGIN PERFORM tests.login('00000000-0000-4000-8000-0000000000b2'); END$d$$q$);
SELECT tests.dblink_exec('add2', 'SET LOCAL ROLE authenticated');
SELECT tests.dblink_exec('add2', $q$DO $d$BEGIN PERFORM public.add_group_member_by_email('10000000-0000-4000-8000-0000000000b2', 'mina@example.test'); END$d$$q$);
SELECT tests.send('del2', ARRAY['SET LOCAL ROLE supabase_auth_admin'],
  $$DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000000000b2' RETURNING id::text$$);
SELECT tests.assert(tests.blocked('del2'), 'add first: the deletion waits for the adding transaction');
SELECT tests.dblink_exec('add2', 'COMMIT');
SELECT tests.dblink_disconnect('add2');
SELECT tests.assert_eq(tests.outcome('del2'), 'owner_must_transfer',
  'add first: the deletion sees the new member and is refused');
SELECT tests.assert(EXISTS (SELECT 1 FROM auth.users WHERE id = '00000000-0000-4000-8000-0000000000b2'),
  'add first: the owner account still exists');

-- The invariant either way: no group has active members but no active owner.
SELECT tests.assert(NOT EXISTS (
  SELECT 1 FROM public.groups g
   WHERE EXISTS (SELECT 1 FROM public.group_members gm WHERE gm.group_id = g.id AND gm.left_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM public.group_members gm
                      WHERE gm.group_id = g.id AND gm.left_at IS NULL AND gm.role = 'owner')),
  'no group has active members without an active owner');
