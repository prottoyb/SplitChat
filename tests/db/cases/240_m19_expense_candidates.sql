-- M19: Smart Expense candidates (ADR-0012). Fixture: G1 "Flat" owner A,
-- members B, E; G2 "Trip" owner D, members C, A. C and D are outsiders to G1.

CREATE FUNCTION tests.u(letter text) RETURNS uuid LANGUAGE sql IMMUTABLE
  AS $f$ SELECT ('00000000-0000-4000-8000-00000000000' || letter)::uuid $f$;
CREATE FUNCTION tests.g1() RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT '10000000-0000-4000-8000-000000000001'::uuid $f$;
CREATE FUNCTION tests.g2() RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT '10000000-0000-4000-8000-000000000002'::uuid $f$;
CREATE FUNCTION tests.everyone() RETURNS uuid[] LANGUAGE sql IMMUTABLE
  AS $f$ SELECT ARRAY[tests.u('a'), tests.u('b'), tests.u('e')] $f$;

-- Runs `sql` as `letter` (authenticated) and returns its text result.
CREATE FUNCTION tests.as_user(letter text, sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  v text;
BEGIN
  PERFORM tests.login(tests.u(letter));
  SET LOCAL ROLE authenticated;
  EXECUTE 'SELECT (' || sql || ')::text' INTO v;
  RESET ROLE;
  RETURN v;
END $f$;
-- Sends a message as `letter` in `g`; returns its id.
CREATE FUNCTION tests.msg(letter text, g uuid, body text) RETURNS bigint LANGUAGE plpgsql AS $f$
BEGIN
  RETURN tests.as_user(letter, format('(public.send_group_message(%L, %L, gen_random_uuid())).id', g, body))::bigint;
END $f$;
-- Proposes a complete draft for message `m` as `letter`: 30.00 dinner paid by B, split A, B, E.
CREATE FUNCTION tests.propose_full(letter text, m bigint) RETURNS uuid LANGUAGE plpgsql AS $f$
BEGIN
  RETURN tests.as_user(letter, format(
    '(public.propose_expense_candidate(%s, ''natural'', ''deterministic-1'', ''Dinner'', 3000, current_date, %L, %L)).id',
    m, tests.u('b'), tests.everyone()))::uuid;
END $f$;
-- Unfiltered views (definer) for assertions made as any role.
CREATE FUNCTION tests.cand(id uuid) RETURNS public.expense_candidates LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT * FROM public.expense_candidates WHERE id = $1
$f$;
CREATE FUNCTION tests.expense_count() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT count(*) FROM public.expenses
$f$;
CREATE FUNCTION tests.created_events(expense uuid) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT count(*) FROM public.group_events WHERE kind = 'expense_created' AND subject_id = expense
$f$;
CREATE FUNCTION tests.created_payload(expense uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT payload FROM public.group_events WHERE kind = 'expense_created' AND subject_id = expense
$f$;
CREATE FUNCTION tests.g1_total() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT coalesce(sum(net_cents), 0)::bigint FROM private.group_balances('10000000-0000-4000-8000-000000000001')
$f$;
CREATE FUNCTION tests.raises(letter text, sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM tests.as_user(letter, sql);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RETURN SQLERRM;
END $f$;

-- Surface ------------------------------------------------------------------------
SELECT tests.assert((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.expense_candidates'::regclass), 'RLS on expense_candidates');
SELECT tests.assert(has_table_privilege('authenticated', 'public.expense_candidates', 'SELECT'), 'members can read candidates (RLS-filtered)');
SELECT tests.assert(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
                                 WHERE has_table_privilege('authenticated', 'public.expense_candidates', p)),
  'clients cannot write candidates directly');
SELECT tests.assert(EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'expense_candidates' AND roles = ARRAY['anon']::name[]
                             AND permissive = 'RESTRICTIVE' AND qual = 'false'),
  'M23: a restrictive policy denies every candidate row to anon');
SELECT tests.assert(NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY['public.propose_expense_candidate(bigint,text,text,text,bigint,date,uuid,uuid[],text)',
                               'public.update_expense_candidate(uuid,integer,text,bigint,date,uuid,uuid[],text)',
                               'public.reject_expense_candidate(uuid,integer)', 'public.approve_expense_candidate(uuid,integer)']) f
     WHERE has_function_privilege('anon', f, 'EXECUTE') OR NOT has_function_privilege('authenticated', f, 'EXECUTE')),
  'members, not anon, can call the candidate RPCs');
SELECT tests.assert(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
    WHERE has_function_privilege(r, 'private.create_equal_split_expense_core(uuid,uuid,text,bigint,date,uuid,uuid[],text,jsonb)', 'EXECUTE')),
  'the expense core is private');
SELECT tests.assert(EXISTS (SELECT 1 FROM pg_publication_tables
                             WHERE pubname = 'supabase_realtime' AND tablename = 'expense_candidates'),
  'expense_candidates is published for Realtime');

-- The core refuses a null actor; v2's payload carries no provenance (condition 2/3).
BEGIN;
SELECT tests.assert_raises($$SELECT private.create_equal_split_expense_core(NULL, tests.g1(), 'x', 100, current_date,
  tests.u('a'), ARRAY[tests.u('a')], NULL)$$, 'P0001', 'the core refuses a missing actor', 'auth_required');
CREATE TEMP TABLE manual AS SELECT tests.as_user('b', format('public.create_equal_split_expense_v2(%L, ''Manual'', 900, current_date, %L, %L)',
  tests.g1(), tests.u('b'), tests.everyone()))::uuid AS id;
SELECT tests.assert(NOT (tests.created_payload((SELECT id FROM manual)) ?| ARRAY['candidate_id', 'message_id', 'proposed_by']),
  'a manual expense event has no candidate provenance');
ROLLBACK;

-- Propose -----------------------------------------------------------------------------
BEGIN;
CREATE TEMP TABLE m AS SELECT tests.msg('b', tests.g1(), 'Dinner 30.00 split with everyone, I paid') AS id;
GRANT SELECT ON m TO PUBLIC;
CREATE TEMP TABLE c AS SELECT tests.propose_full('b', (SELECT id FROM m)) AS id;
GRANT SELECT ON c TO PUBLIC;
SELECT tests.assert_eq((tests.cand((SELECT id FROM c))).status, 'proposed', 'the sender proposes a candidate');
SELECT tests.assert_eq((tests.cand((SELECT id FROM c))).proposed_by, tests.u('b'), 'the proposer is the sender');
SELECT tests.assert_eq(
  tests.as_user('b', format('(public.propose_expense_candidate(%s, ''command'', ''other'', ''Changed'', 1, NULL, NULL, NULL)).id', (SELECT id FROM m)))::uuid,
  (SELECT id FROM c), 'proposing again for the message returns the existing candidate');
SELECT tests.assert_eq((tests.cand((SELECT id FROM c))).description, 'Dinner', 'and does not change it');
SELECT tests.assert_eq(tests.raises('a', format('public.propose_expense_candidate(%s, ''natural'', ''d'', NULL, NULL, NULL, NULL, NULL)', (SELECT id FROM m))),
  'forbidden', 'nobody else can propose on a person''s message, not even the owner');
SELECT tests.assert_eq(tests.raises('c', format('public.propose_expense_candidate(%s, ''natural'', ''d'', NULL, NULL, NULL, NULL, NULL)', (SELECT id FROM m))),
  'not_found_or_forbidden', 'an outsider cannot propose');
SELECT tests.assert_eq(tests.raises('b', 'public.propose_expense_candidate(999999999, ''natural'', ''d'', NULL, NULL, NULL, NULL, NULL)'),
  'not_found_or_forbidden', 'an unknown message is refused');
ROLLBACK;

BEGIN;
CREATE TEMP TABLE m AS SELECT tests.msg('b', tests.g1(), 'hello') AS id;
GRANT SELECT ON m TO PUBLIC;
SELECT tests.assert_eq(tests.raises('b', format('public.propose_expense_candidate(%s, ''llm'', ''d'', NULL, NULL, NULL, NULL, NULL)', (SELECT id FROM m))),
  'invalid_source', 'an unknown source is refused');
SELECT tests.assert_eq(tests.raises('b', format('public.propose_expense_candidate(%s, ''natural'', %L, NULL, NULL, NULL, NULL, NULL)', (SELECT id FROM m), repeat('v', 33))),
  'invalid_source', 'an over-long interpreter version is refused');
SELECT tests.assert_eq(tests.raises('b', format('public.propose_expense_candidate(%s, ''natural'', ''d'', NULL, NULL, NULL, %L, NULL)', (SELECT id FROM m), tests.u('c'))),
  'invalid_payer', 'a payer outside the group is refused');
SELECT tests.assert_eq(tests.raises('b', format('public.propose_expense_candidate(%s, ''natural'', ''d'', NULL, NULL, NULL, NULL, %L)', (SELECT id FROM m), ARRAY[tests.u('a'), tests.u('a')])),
  'invalid_participants', 'duplicate participants are refused');
SELECT tests.assert_eq(tests.raises('b', format('public.propose_expense_candidate(%s, ''natural'', ''d'', NULL, NULL, NULL, NULL, %L)', (SELECT id FROM m), ARRAY[tests.u('a'), tests.u('c')])),
  'invalid_participants', 'a participant outside the group is refused');
SELECT tests.assert_eq(tests.raises('b', format('public.propose_expense_candidate(%s, ''natural'', ''d'', NULL, 0, NULL, NULL, NULL)', (SELECT id FROM m))),
  'invalid_amount', 'a zero amount is refused');
SELECT tests.assert_eq(tests.raises('b', format('public.propose_expense_candidate(%s, ''natural'', ''d'', NULL, 1000000000000, NULL, NULL, NULL)', (SELECT id FROM m))),
  'invalid_amount', 'an amount over the limit is refused');
SELECT tests.assert_eq(tests.raises('b', format('public.propose_expense_candidate(%s, ''natural'', ''d'', NULL, NULL, DATE ''1999-12-31'', NULL, NULL)', (SELECT id FROM m))),
  'invalid_date', 'a date before 2000 is refused');
SELECT tests.assert_eq(tests.raises('b', format('public.propose_expense_candidate(%s, ''natural'', ''d'', %L, NULL, NULL, NULL, NULL)', (SELECT id FROM m), repeat('d', 121))),
  'invalid_description', 'a description over 120 characters is refused');
SELECT tests.assert_eq(tests.raises('b', format('public.propose_expense_candidate(%s, ''manual'', ''d'', ''  '', NULL, current_date, NULL, NULL)', (SELECT id FROM m))),
  'ok', 'a draft may leave every critical field missing (a blank description counts as missing)');
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$INSERT INTO public.expense_candidates (group_id, message_id, proposed_by, source, interpreter_version)
  VALUES (tests.g1(), 1, tests.u('b'), 'natural', 'd')$$, '42501', 'a direct insert is denied');
RESET ROLE;
SET LOCAL ROLE anon;
SELECT tests.assert_raises($$SELECT public.approve_expense_candidate(gen_random_uuid(), 1)$$, '42501', 'anon cannot approve');
RESET ROLE;
ROLLBACK;

-- Update: manage rule, stale version --------------------------------------------------
BEGIN;
CREATE TEMP TABLE c AS SELECT tests.propose_full('b', tests.msg('b', tests.g1(), 'Dinner 30')) AS id;
GRANT SELECT ON c TO PUBLIC;
SELECT tests.assert_eq(tests.raises('b', format('public.update_expense_candidate(%L, 1, ''Dinner out'', 3300, current_date, %L, %L)',
  (SELECT id FROM c), tests.u('b'), tests.everyone())), 'ok', 'the proposer edits the draft');
SELECT tests.assert_eq((tests.cand((SELECT id FROM c))).version, 2, 'an edit bumps the version');
SELECT tests.assert_eq(tests.raises('b', format('public.update_expense_candidate(%L, 1, ''Late'', 3300, current_date, %L, %L)',
  (SELECT id FROM c), tests.u('b'), tests.everyone())), 'stale_candidate', 'an edit of an older version is refused');
SELECT tests.assert_eq(tests.raises('e', format('public.update_expense_candidate(%L, 2, ''Mine now'', 1, NULL, NULL, NULL)', (SELECT id FROM c))),
  'forbidden', 'another member cannot edit it');
SELECT tests.assert_eq(tests.raises('c', format('public.update_expense_candidate(%L, 2, ''x'', 1, NULL, NULL, NULL)', (SELECT id FROM c))),
  'not_found_or_forbidden', 'an outsider cannot edit it');
SELECT tests.assert_eq(tests.raises('a', format('public.update_expense_candidate(%L, 2, ''Dinner (owner fix)'', 3300, current_date, %L, %L)',
  (SELECT id FROM c), tests.u('b'), tests.everyone())), 'ok', 'the owner can edit it');
SELECT tests.assert_eq(tests.as_user('c', format('(SELECT count(*) FROM public.expense_candidates WHERE id = %L)', (SELECT id FROM c))), '0',
  'an outsider cannot see it');
SELECT tests.assert_eq(tests.as_user('e', format('(SELECT count(*) FROM public.expense_candidates WHERE id = %L)', (SELECT id FROM c))), '1',
  'every member can see it');
ROLLBACK;

-- Approve: the canonical path, idempotent, provenance -----------------------------------
BEGIN;
CREATE TEMP TABLE partial AS SELECT tests.as_user('b', format(
  '(public.propose_expense_candidate(%s, ''natural'', ''d'', ''Taxi'', 2000, current_date, NULL, %L)).id',
  tests.msg('b', tests.g1(), 'Taxi 20 split with everyone'), tests.everyone()))::uuid AS id;
GRANT SELECT ON partial TO PUBLIC;
SELECT tests.assert_eq(tests.raises('b', format('public.approve_expense_candidate(%L, 1)', (SELECT id FROM partial))),
  'candidate_incomplete', 'an incomplete draft (no payer) cannot be approved');

CREATE TEMP TABLE c AS SELECT tests.propose_full('b', tests.msg('b', tests.g1(), 'Dinner 30')) AS id;
GRANT SELECT ON c TO PUBLIC;
CREATE TEMP TABLE before AS SELECT tests.expense_count() AS n;
GRANT SELECT ON before TO PUBLIC;
SELECT tests.assert_eq(tests.raises('e', format('public.approve_expense_candidate(%L, 1)', (SELECT id FROM c))),
  'forbidden', 'another member cannot approve it');
SELECT tests.assert_eq(tests.raises('b', format('public.approve_expense_candidate(%L, 7)', (SELECT id FROM c))),
  'stale_candidate', 'approving a version other than the one reviewed is refused');
CREATE TEMP TABLE e AS SELECT tests.as_user('b', format('public.approve_expense_candidate(%L, 1)', (SELECT id FROM c)))::uuid AS id;
GRANT SELECT ON e TO PUBLIC;
SELECT tests.assert_eq(tests.expense_count(), (SELECT n FROM before) + 1, 'approval creates one expense');
SELECT tests.assert_eq((tests.cand((SELECT id FROM c))).status, 'approved', 'the candidate is approved');
SELECT tests.assert_eq((tests.cand((SELECT id FROM c))).expense_id, (SELECT id FROM e), 'and linked to its expense');
SELECT tests.assert_eq((SELECT created_by FROM public.expenses WHERE id = (SELECT id FROM e)), tests.u('b'), 'the approver is the expense creator');
SELECT tests.assert_eq((SELECT sum(share_amount) FROM public.expense_splits WHERE expense_id = (SELECT id FROM e)), 30.00::numeric,
  'the canonical split covers the amount exactly');
SELECT tests.assert_eq((SELECT count(*) FROM public.expense_splits WHERE expense_id = (SELECT id FROM e)), 3::bigint, 'one share per participant');
SELECT tests.assert_eq(tests.created_payload((SELECT id FROM e)) ->> 'candidate_id', (SELECT id::text FROM c), 'the event names the candidate');
SELECT tests.assert_eq(tests.created_payload((SELECT id FROM e)) ->> 'proposed_by', tests.u('b')::text, 'and the proposer');
SELECT tests.assert((tests.created_payload((SELECT id FROM e)) ->> 'message_id') IS NOT NULL, 'and the message');
SELECT tests.assert_eq(tests.as_user('b', format('public.approve_expense_candidate(%L, 1)', (SELECT id FROM c)))::uuid, (SELECT id FROM e),
  'approving again returns the same expense');
SELECT tests.assert_eq(tests.as_user('a', format('public.approve_expense_candidate(%L, 99)', (SELECT id FROM c)))::uuid, (SELECT id FROM e),
  'also for the owner, whatever version is sent');
SELECT tests.assert_eq(tests.raises('e', format('public.approve_expense_candidate(%L, 2)', (SELECT id FROM c))),
  'forbidden', 'a member outside the manage rule does not learn the expense id');
SELECT tests.assert_eq(tests.expense_count(), (SELECT n FROM before) + 1, 'still exactly one expense');
SELECT tests.assert_eq(tests.created_events((SELECT id FROM e)), 1::bigint, 'and one expense_created event');
SELECT tests.assert_eq(tests.raises('b', format('public.update_expense_candidate(%L, 2, ''x'', 1, NULL, NULL, NULL)', (SELECT id FROM c))),
  'candidate_decided', 'an approved candidate cannot be edited');
SELECT tests.assert_eq(tests.raises('b', format('public.reject_expense_candidate(%L, 2)', (SELECT id FROM c))),
  'candidate_decided', 'or rejected');
SELECT tests.assert_raises(format($$UPDATE public.expense_candidates SET amount_cents = 1 WHERE id = %L$$, (SELECT id FROM c)),
  'P0001', 'a decided candidate is immutable, even for the table owner', 'candidate_decided');
SELECT tests.assert_eq(tests.g1_total(), 0::bigint, 'the group still nets to zero');
-- The expense is deleted later: approving again never re-creates it.
SELECT tests.as_user('b', format('public.delete_expense(%L, %L)', (SELECT id FROM e),
  (SELECT updated_at FROM public.expenses WHERE id = (SELECT id FROM e))));
SELECT tests.assert_eq(tests.as_user('b', format('public.approve_expense_candidate(%L, 2)', (SELECT id FROM c)))::uuid, (SELECT id FROM e),
  'after the expense was deleted, approval returns the same id');
SELECT tests.assert_eq(tests.expense_count(), (SELECT n FROM before), 'and creates nothing');
ROLLBACK;

-- Reject ----------------------------------------------------------------------------------
BEGIN;
CREATE TEMP TABLE c AS SELECT tests.propose_full('b', tests.msg('b', tests.g1(), 'Dinner 30')) AS id;
GRANT SELECT ON c TO PUBLIC;
SELECT tests.assert_eq(tests.raises('e', format('public.reject_expense_candidate(%L, 1)', (SELECT id FROM c))), 'forbidden', 'another member cannot reject it');
SELECT tests.assert_eq(tests.raises('b', format('public.reject_expense_candidate(%L, 1)', (SELECT id FROM c))), 'ok', 'the proposer rejects it');
SELECT tests.assert_eq(tests.raises('b', format('public.reject_expense_candidate(%L, 1)', (SELECT id FROM c))), 'ok', 'rejecting again is harmless');
SELECT tests.assert_eq((tests.cand((SELECT id FROM c))).decided_by, tests.u('b'), 'the decision is recorded');
SELECT tests.assert_eq(tests.raises('b', format('public.approve_expense_candidate(%L, 2)', (SELECT id FROM c))), 'candidate_rejected',
  'a rejected candidate cannot be approved');
ROLLBACK;

-- Departed proposer, departed participant ---------------------------------------------------
BEGIN;
CREATE TEMP TABLE c AS SELECT tests.propose_full('e', tests.msg('e', tests.g1(), 'Dinner 30')) AS id;
GRANT SELECT ON c TO PUBLIC;
UPDATE public.expense_candidates SET paid_by = tests.u('a') WHERE id = (SELECT id FROM c);  -- payer A, proposer E
SELECT tests.as_user('e', format('public.leave_group(%L)', tests.g1()));
SELECT tests.assert_eq(tests.raises('e', format('public.approve_expense_candidate(%L, 1)', (SELECT id FROM c))),
  'not_found_or_forbidden', 'a proposer who left cannot approve');
SELECT tests.assert_eq(tests.raises('a', format('public.approve_expense_candidate(%L, 1)', (SELECT id FROM c))),
  'invalid_participants', 'a participant who left makes the draft unapprovable');
SELECT tests.assert_eq((tests.cand((SELECT id FROM c))).status, 'proposed', 'and it stays proposed');
SELECT tests.as_user('a', format('public.update_expense_candidate(%L, 1, ''Dinner'', 3000, current_date, %L, %L)',
  (SELECT id FROM c), tests.u('a'), ARRAY[tests.u('a'), tests.u('b')]));
SELECT tests.assert((tests.as_user('a', format('public.approve_expense_candidate(%L, 2)', (SELECT id FROM c)))) IS NOT NULL,
  'the owner finishes a departed proposer''s candidate');
SELECT tests.assert_eq((SELECT created_by FROM public.expenses WHERE id = (tests.cand((SELECT id FROM c))).expense_id), tests.u('a'),
  'with the owner as the expense creator');
SELECT tests.assert_eq(tests.as_user('e', format('(SELECT count(*) FROM public.expense_candidates WHERE id = %L)', (SELECT id FROM c))), '0',
  'a former member no longer sees candidates');
ROLLBACK;

-- Cascade with the group only ---------------------------------------------------------------
BEGIN;
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
INSERT INTO public.groups (name, created_by) VALUES ('Solo candidates', tests.u('a'));
RESET ROLE;
CREATE TEMP TABLE solo AS SELECT id FROM public.groups WHERE name = 'Solo candidates';
GRANT SELECT ON solo TO PUBLIC;
CREATE TEMP TABLE c AS SELECT tests.as_user('a', format(
  '(public.propose_expense_candidate(%s, ''manual'', ''d'', NULL, NULL, current_date, NULL, NULL)).id',
  tests.msg('a', (SELECT id FROM solo), 'note'))) ::uuid AS id;
SELECT tests.assert_raises(format($$DELETE FROM public.expense_candidates WHERE id = %L$$, (SELECT id FROM c)),
  'P0001', 'a candidate cannot be deleted on its own', 'expense_candidates_immutable');
SELECT tests.assert_eq(tests.raises('a', format('public.delete_group(%L)', (SELECT id FROM solo))), 'ok',
  'a solo group with a proposed candidate can still be deleted');
SELECT tests.assert((tests.cand((SELECT id FROM c))).id IS NULL, 'its candidates go with it');
ROLLBACK;
