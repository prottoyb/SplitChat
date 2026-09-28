-- M16: append-only activity event log (ADR-0009 conditions 2-10).
-- Fixture: G1 owner A (members B, E); G2 owner D (members C, A).
--   X1 (G1) 100.00 by A split A/B; X2 (G1) 10.00 by B split A/B/E; X3 (G2) by C.

CREATE FUNCTION tests.u(letter text) RETURNS uuid LANGUAGE sql IMMUTABLE
  AS $f$ SELECT ('00000000-0000-4000-8000-00000000000' || letter)::uuid $f$;
CREATE FUNCTION tests.x(n int) RETURNS uuid LANGUAGE sql IMMUTABLE
  AS $f$ SELECT ('20000000-0000-4000-8000-00000000000' || n)::uuid $f$;
CREATE FUNCTION tests.g1() RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT '10000000-0000-4000-8000-000000000001'::uuid $f$;
-- Seeding the fixture already recorded group_created for G1 and G2 (the
-- trigger is live), so only events after this baseline count.
CREATE TABLE tests.event_baseline AS SELECT coalesce(max(id), 0) AS id FROM public.group_events;
GRANT SELECT ON tests.event_baseline TO PUBLIC;
-- Events since the case started, as "kind:actor:subject_user".
CREATE FUNCTION tests.new_events() RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT coalesce(array_agg(kind || ':' || coalesce(right(actor_id::text, 1), '-') || ':' || coalesce(right(subject_user_id::text, 1), '-')
                            ORDER BY id), '{}')
    FROM public.group_events WHERE NOT backfilled AND id > (SELECT id FROM tests.event_baseline)
$f$;
CREATE FUNCTION tests.last_payload() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT payload FROM public.group_events ORDER BY id DESC LIMIT 1
$f$;

-- Surface --------------------------------------------------------------------
SELECT tests.assert((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.group_events'::regclass), 'RLS on group_events');
SELECT tests.assert(has_table_privilege('authenticated', 'public.group_events', 'SELECT'), 'members can read events (RLS-filtered)');
SELECT tests.assert(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p
                                 WHERE has_table_privilege('authenticated', 'public.group_events', p)),
  'clients cannot write events');
SELECT tests.assert(NOT has_table_privilege('anon', 'public.group_events', 'SELECT'), 'anon cannot read events');
SELECT tests.assert(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
                                 WHERE has_function_privilege(r, 'private.record_group_event(uuid,uuid,text,uuid,uuid,uuid[],jsonb)', 'EXECUTE')),
  'no client or service role can write through the helper');

-- Every mutating path records exactly one event of the right kind ------------
BEGIN;
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE made AS
SELECT public.create_equal_split_expense_v2(tests.g1(), 'Secret dinner at Mario''s', 1001, DATE '2026-09-20', tests.u('b'),
  ARRAY[tests.u('e'), tests.u('a'), tests.u('b')], 'private note') AS id;
RESET ROLE;
SELECT tests.assert_eq(tests.new_events(), ARRAY['expense_created:b:-'], 'create -> one expense_created by the creator');
SELECT tests.assert_eq(tests.last_payload() - 'v',
  jsonb_build_object('amount_cents', 1001, 'expense_date', '2026-09-20', 'paid_by', tests.u('b'),
                     'participants', jsonb_build_array(tests.u('a'), tests.u('b'), tests.u('e'))),
  'expense_created payload: cents, date, payer, sorted participants');
SELECT tests.assert(tests.last_payload()::text !~ '(Secret|Mario|private note)', 'no description or notes in the payload');

SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
SELECT public.update_equal_split_expense((SELECT id FROM made), (SELECT updated_at FROM public.expenses WHERE id = (SELECT id FROM made)),
  'Renamed dinner', 1500, DATE '2026-09-20', tests.u('a'), ARRAY[tests.u('a'), tests.u('b')], 'private note');
RESET ROLE;
SELECT tests.assert_eq(tests.new_events(), ARRAY['expense_created:b:-', 'expense_updated:b:-'], 'edit -> one expense_updated');
SELECT tests.assert_eq(tests.last_payload() - 'v', jsonb_build_object(
    'changes', jsonb_build_object(
      'amount_cents', jsonb_build_object('from', 1001, 'to', 1500),
      'paid_by', jsonb_build_object('from', tests.u('b'), 'to', tests.u('a')),
      'participants', jsonb_build_object('from', jsonb_build_array(tests.u('a'), tests.u('b'), tests.u('e')),
                                         'to', jsonb_build_array(tests.u('a'), tests.u('b')))),
    'description_changed', true, 'notes_changed', false),
  'expense_updated records only changed fields and flags (never the text)');
SELECT tests.assert(tests.last_payload()::text !~ '(Renamed|dinner|private note)', 'no description text in an edit event');

SELECT tests.login(tests.u('a'));  -- owner deletes
SET LOCAL ROLE authenticated;
SELECT public.delete_expense((SELECT id FROM made), (SELECT updated_at FROM public.expenses WHERE id = (SELECT id FROM made)));
RESET ROLE;
SELECT tests.assert_eq((tests.new_events())[3], 'expense_deleted:a:-', 'delete -> one expense_deleted by the owner');
SELECT tests.assert_eq(tests.last_payload() - 'v', jsonb_build_object(
    'amount_cents', 1500, 'expense_date', '2026-09-20', 'paid_by', tests.u('a'), 'created_by', tests.u('b'),
    'participants', jsonb_build_array(tests.u('a'), tests.u('b'))),
  'expense_deleted keeps amount, date and people only (no description snapshot: operator decision)');

-- Membership paths.
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
SELECT public.remove_group_member(tests.g1(), tests.u('e'));
SELECT result FROM public.add_group_member_by_email(tests.g1(), 'eve@example.test');     -- rejoin
SELECT result FROM public.add_group_member_by_email(tests.g1(), 'cara@example.test');    -- new member
SELECT public.transfer_group_ownership(tests.g1(), tests.u('b'));
RESET ROLE;
SELECT tests.login(tests.u('c'));
SET LOCAL ROLE authenticated;
SELECT public.leave_group(tests.g1());
RESET ROLE;
SELECT tests.assert_eq((tests.new_events())[4:], ARRAY[
    'member_removed:a:e', 'member_rejoined:a:e', 'member_added:a:c', 'ownership_transferred:a:b', 'member_left:c:c'],
  'remove, re-add, add, transfer, leave -> one event each, with actor and subject');
SELECT tests.assert_eq(
  (SELECT payload - 'v' FROM public.group_events WHERE kind = 'ownership_transferred' AND NOT backfilled),
  jsonb_build_object('from', tests.u('a'), 'to', tests.u('b')), 'transfer payload names from/to');

-- Group creation (trigger on the direct INSERT).
SELECT tests.login(tests.u('d'));
SET LOCAL ROLE authenticated;
INSERT INTO public.groups (name, created_by) VALUES ('Brand new group', tests.u('d'));  -- column grants: no id
RESET ROLE;
SELECT tests.assert_eq(
  (SELECT kind || ':' || right(actor_id::text, 1) FROM public.group_events
    WHERE group_id = (SELECT id FROM public.groups WHERE name = 'Brand new group')),
  'group_created:d', 'creating a group records group_created');

-- Failed calls record nothing.
SELECT tests.login(tests.u('c'));
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE before_count AS SELECT tests.new_events() AS e;
SELECT tests.assert_raises($$SELECT public.remove_group_member(tests.g1(), tests.u('b'))$$, 'P0001', 'outsider remove refused', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.create_equal_split_expense_v2(tests.g1(), 'x', 0, current_date, tests.u('c'), ARRAY[tests.u('c')])$$,
  'P0001', 'invalid create refused', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.assert_eq(tests.new_events(), (SELECT e FROM before_count), 'refused calls record no event');
ROLLBACK;

SELECT tests.assert_eq(tests.new_events(), '{}'::text[], 'rolled-back changes leave no event');

-- Account deletion and operator release ----------------------------------------
BEGIN;
SET LOCAL ROLE supabase_auth_admin;
DELETE FROM auth.users WHERE id = tests.u('e');
RESET ROLE;
SELECT tests.assert_eq(tests.new_events(), ARRAY['member_account_deleted:-:e'], 'account deletion -> member_account_deleted, actor null');
SELECT tests.assert_eq(tests.last_payload() - 'v', '{"was_owner": false}'::jsonb, 'payload records the former role');
SET LOCAL ROLE postgres;
SELECT * FROM private.admin_release_ownership(tests.u('a'));
RESET ROLE;
SELECT tests.assert_eq((tests.new_events())[2], 'ownership_transferred:-:b', 'operator release -> ownership_transferred, actor null');
SELECT tests.assert_eq(tests.last_payload() ->> 'operator_release', 'true', 'marked as an operator release');
ROLLBACK;

-- Readers: active members only ----------------------------------------------------
BEGIN;
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
SELECT tests.assert((SELECT count(*) > 0 FROM public.group_events), 'a member reads events of their groups');
SELECT tests.assert_eq((SELECT count(*) FROM public.group_events WHERE group_id <> tests.g1()), 0::bigint, 'and nothing from other groups');
RESET ROLE;
UPDATE public.group_members SET left_at = now(), left_reason = 'left' WHERE group_id = tests.g1() AND user_id = tests.u('e');
SELECT tests.login(tests.u('e'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq((SELECT count(*) FROM public.group_events), 0::bigint, 'a former member reads no events');
RESET ROLE;
ROLLBACK;

-- Immutability; solo delete_group cascade ----------------------------------------
BEGIN;
SET LOCAL ROLE postgres;
SELECT tests.assert_raises($$UPDATE public.group_events SET kind = 'member_left' WHERE id = (SELECT min(id) FROM public.group_events)$$,
  'P0001', 'events cannot be updated, even by postgres', 'group_events_immutable');
SELECT tests.assert_raises($$DELETE FROM public.group_events WHERE group_id = '10000000-0000-4000-8000-000000000001'$$,
  'P0001', 'events cannot be deleted while their group exists', 'group_events_immutable');
RESET ROLE;
INSERT INTO public.groups (id, name, created_by) VALUES ('10000000-0000-4000-8000-0000000000e2', 'Solo', tests.u('d'));
SELECT tests.login(tests.u('d'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok($$SELECT public.delete_group('10000000-0000-4000-8000-0000000000e2')$$, 'solo group deletion still works');
RESET ROLE;
SELECT tests.assert_eq((SELECT count(*) FROM public.group_events WHERE group_id = '10000000-0000-4000-8000-0000000000e2'), 0::bigint,
  'its events cascade away with it');
ROLLBACK;

-- Names for people referenced only by events (condition 5) -------------------------
BEGIN;
INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at)
VALUES ('00000000-0000-4000-8000-0000000000c9', 'zed@example.test', '{"full_name":"Zed"}', now());
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
SELECT result FROM public.add_group_member_by_email(tests.g1(), 'zed@example.test');
SELECT public.remove_group_member(tests.g1(), '00000000-0000-4000-8000-0000000000c9');
SELECT tests.assert_eq(
  (SELECT display_name FROM public.get_ledger_identities(tests.g1()) WHERE user_id = '00000000-0000-4000-8000-0000000000c9'),
  'Zed', 'a removed member with no expenses is still named in the feed');
RESET ROLE;
ROLLBACK;

-- Backfill (condition 10): exact synthesized history for the seeded data ------------
SELECT tests.assert_eq((SELECT count(*) FROM public.group_events WHERE backfilled), 0::bigint,
  'the fixture is seeded after the migration, so nothing was backfilled yet (see below)');
BEGIN;
SET LOCAL ROLE postgres;
\ir ../../../supabase/rollbacks/20260928100000_activity_event_log.down.sql
\ir ../../../supabase/migrations/20260928100000_activity_event_log.sql
RESET ROLE;
SELECT tests.assert_eq(
  (SELECT array_agg(kind ORDER BY kind) FROM public.group_events WHERE backfilled AND group_id = tests.g1()),
  ARRAY['expense_created', 'expense_created', 'group_created', 'member_added', 'member_added'],
  'backfill for G1: group, two non-creator members, two expenses');
SELECT tests.assert(NOT EXISTS (SELECT 1 FROM public.group_events WHERE NOT backfilled), 'every synthesized event is marked backfilled');
SELECT tests.assert_eq(
  (SELECT payload - 'v' FROM public.group_events WHERE backfilled AND subject_id = tests.x(2)),
  jsonb_build_object('amount_cents', 1000, 'expense_date', (SELECT expense_date FROM public.expenses WHERE id = tests.x(2)),
                     'paid_by', tests.u('b'), 'participants', jsonb_build_array(tests.u('a'), tests.u('b'), tests.u('e'))),
  'backfilled expense_created carries the stored cents and people');
ROLLBACK;
