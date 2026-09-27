-- M13: update_equal_split_expense / delete_expense (design §A2, §A7, F9, S3,
-- S9). Fixture: G1 owner A, members B, E; G2 owner D, members C, A.
--   X1 (G1) created/paid by A, split A/B
--   X2 (G1) created/paid by B, split A/B/E
--   X3 (G2) created/paid by C, split C/A

-- Surface and grants ----------------------------------------------------------
SELECT tests.assert(has_function_privilege('authenticated',
  'public.update_equal_split_expense(uuid,timestamptz,text,bigint,date,uuid,uuid[],text)', 'EXECUTE'), 'authenticated can execute update');
SELECT tests.assert(has_function_privilege('authenticated', 'public.delete_expense(uuid,timestamptz)', 'EXECUTE'),
  'authenticated can execute delete');
SELECT tests.assert(NOT has_function_privilege('anon',
  'public.update_equal_split_expense(uuid,timestamptz,text,bigint,date,uuid,uuid[],text)', 'EXECUTE'), 'anon cannot execute update');
SELECT tests.assert(NOT has_function_privilege('anon', 'public.delete_expense(uuid,timestamptz)', 'EXECUTE'),
  'anon cannot execute delete');
SELECT tests.assert(NOT has_function_privilege('authenticated',
  'private.lock_expense_for_management(uuid,timestamptz)', 'EXECUTE'), 'the resolution helper is not client-callable');
SELECT tests.assert(NOT has_column_privilege('authenticated', 'public.expenses', 'updated_by', 'UPDATE'),
  'clients cannot write updated_by directly');

CREATE FUNCTION tests.u(letter text) RETURNS uuid LANGUAGE sql IMMUTABLE
  AS $f$ SELECT ('00000000-0000-4000-8000-00000000000' || letter)::uuid $f$;
CREATE FUNCTION tests.x(n int) RETURNS uuid LANGUAGE sql IMMUTABLE
  AS $f$ SELECT ('20000000-0000-4000-8000-00000000000' || n)::uuid $f$;
-- Current updated_at of an expense, read with the caller's own RLS view.
CREATE FUNCTION tests.ts(n int) RETURNS timestamptz LANGUAGE sql STABLE
  AS $f$ SELECT updated_at FROM public.expenses WHERE id = tests.x(n) $f$;
-- The splits of an expense as 'user-letter=cents', canonical order (superuser view).
CREATE FUNCTION tests.splits(n int) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
  AS $f$ SELECT string_agg(right(user_id::text, 1) || '=' || share_cents, ' ' ORDER BY user_id)
          FROM public.expense_splits WHERE expense_id = tests.x(n) $f$;

-- Authorization (DS-1, S3, S9) -------------------------------------------------
BEGIN;
SELECT tests.logout();
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(tests.x(1), now(), 'x', 100, current_date, tests.u('a'), ARRAY[tests.u('a')])$$,
  'P0001', 'no session: update -> auth_required', 'auth_required');
SELECT tests.assert_raises($$SELECT public.delete_expense(tests.x(1), now())$$,
  'P0001', 'no session: delete -> auth_required', 'auth_required');
RESET ROLE;

SELECT tests.login(tests.u('c'));  -- Cara: outsider to G1
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(tests.x(1), now(), 'x', 100, current_date, tests.u('c'), ARRAY[tests.u('c')])$$,
  'P0001', 'outsider: update existing G1 expense -> not_found_or_forbidden', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense('20000000-0000-4000-8000-0000000000ff', now(), 'x', 100, current_date, tests.u('c'), ARRAY[tests.u('c')])$$,
  'P0001', 'outsider: update nonexistent expense -> identical not_found_or_forbidden (S9)', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(NULL, NULL, NULL, NULL, NULL, NULL, NULL)$$,
  'P0001', 'null expense id -> not_found_or_forbidden', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(tests.x(1), NULL, '', -1, NULL, NULL, NULL, repeat('n', 900))$$,
  'P0001', 'outsider with every argument invalid still gets only not_found_or_forbidden', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.delete_expense(tests.x(1), now())$$,
  'P0001', 'outsider: delete existing G1 expense -> not_found_or_forbidden', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.delete_expense('20000000-0000-4000-8000-0000000000ff', now())$$,
  'P0001', 'outsider: delete nonexistent expense -> identical not_found_or_forbidden (S9)', 'not_found_or_forbidden');
RESET ROLE;

SELECT tests.login(tests.u('b'));  -- Bob: member of G1, creator of X2 only
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(tests.x(1), tests.ts(1), 'x', 100, current_date, tests.u('a'), ARRAY[tests.u('a')])$$,
  'P0001', 'member: update another member''s expense -> forbidden', 'forbidden');
SELECT tests.assert_raises($$SELECT public.delete_expense(tests.x(1), tests.ts(1))$$,
  'P0001', 'member: delete another member''s expense -> forbidden', 'forbidden');
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(tests.x(1), now() - interval '1 day', 'x', 100, current_date, tests.u('a'), ARRAY[tests.u('a')])$$,
  'P0001', 'member with a stale timestamp still gets forbidden (authorization before concurrency)', 'forbidden');
RESET ROLE;

SELECT tests.login(tests.u('a'));  -- Alice: owner of G1, plain member of G2
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(tests.x(3), tests.ts(3), 'x', 100, current_date, tests.u('c'), ARRAY[tests.u('c')])$$,
  'P0001', 'owner of G1 has no owner rights in G2 -> forbidden', 'forbidden');
SELECT tests.assert_raises($$SELECT public.delete_expense(tests.x(3), tests.ts(3))$$,
  'P0001', 'owner of G1 cannot delete a G2 member''s expense -> forbidden', 'forbidden');
ROLLBACK;

-- Concurrency ----------------------------------------------------------------
BEGIN;
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(tests.x(2), tests.ts(2) - interval '1 microsecond', 'x', 100, current_date, tests.u('b'), ARRAY[tests.u('b')])$$,
  'P0001', 'creator with an outdated timestamp -> stale_expense', 'stale_expense');
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(tests.x(2), NULL, 'x', 100, current_date, tests.u('b'), ARRAY[tests.u('b')])$$,
  'P0001', 'missing timestamp -> stale_expense', 'stale_expense');
SELECT tests.assert_raises($$SELECT public.delete_expense(tests.x(2), NULL)$$,
  'P0001', 'delete without timestamp -> stale_expense', 'stale_expense');
CREATE TEMP TABLE seen AS SELECT tests.ts(2) AS original;
CREATE TEMP TABLE first_edit AS
SELECT public.update_equal_split_expense(tests.x(2), (SELECT original FROM seen), 'Snacks v2', 1200, DATE '2026-09-21',
  tests.u('b'), ARRAY[tests.u('a'), tests.u('b'), tests.u('e')]) AS new_ts;
SELECT tests.assert_eq((SELECT new_ts FROM first_edit), tests.ts(2), 'update returns the new updated_at');
SELECT tests.assert((SELECT new_ts FROM first_edit) <> (SELECT original FROM seen), 'updated_at advanced');
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(tests.x(2), (SELECT original FROM seen), 'lost update', 900, current_date, tests.u('b'), ARRAY[tests.u('b')])$$,
  'P0001', 'a second edit based on the pre-edit timestamp is rejected (no lost update)', 'stale_expense');
SELECT tests.assert_raises($$SELECT public.delete_expense(tests.x(2), (SELECT original FROM seen))$$,
  'P0001', 'a delete based on the pre-edit timestamp is rejected', 'stale_expense');
ROLLBACK;

-- Creator edits their own expense: every supported field ----------------------
BEGIN;
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
SELECT public.update_equal_split_expense(tests.x(2), tests.ts(2), '  Snacks and drinks  ', 1001, DATE '2026-09-15',
  tests.u('a'), ARRAY[tests.u('e'), tests.u('b')], '  corner shop  ');
RESET ROLE;
SELECT tests.assert_eq(
  (SELECT row(group_id, description, amount, amount_cents, expense_date, paid_by, created_by, updated_by, notes)::text
     FROM public.expenses WHERE id = tests.x(2)),
  row('10000000-0000-4000-8000-000000000001'::uuid, 'Snacks and drinks', 10.01::numeric, 1001::bigint, DATE '2026-09-15',
      tests.u('a'), tests.u('b'), tests.u('b'), 'corner shop')::text,
  'creator edit: description, amount, date, payer, notes updated; group and creator unchanged; updated_by recorded');
SELECT tests.assert_eq(tests.splits(2), 'b=501 e=500', 'participant set replaced; canonical remainder to the lowest UUID');
SET CONSTRAINTS ALL IMMEDIATE;
SELECT tests.assert(true, 'edited expense passes the deferred balance and membership checks');
ROLLBACK;

-- Owner edits a member's expense; former members stay valid history ----------
BEGIN;
UPDATE public.group_members SET left_at = now(), left_reason = 'left'
 WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id IN (tests.u('b'), tests.u('e'));
SELECT tests.login(tests.u('b'));  -- Bob left: his own expense is no longer his to manage
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(tests.x(2), now(), 'x', 100, current_date, tests.u('b'), ARRAY[tests.u('b')])$$,
  'P0001', 'creator who left -> not_found_or_forbidden', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.delete_expense(tests.x(2), now())$$,
  'P0001', 'creator who left cannot delete -> not_found_or_forbidden', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.login(tests.u('e'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(tests.x(2), now(), 'x', 100, current_date, tests.u('e'), ARRAY[tests.u('e')])$$,
  'P0001', 'former member participant -> not_found_or_forbidden', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.login(tests.u('a'));  -- Alice: owner
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok($$SELECT public.update_equal_split_expense(tests.x(2), tests.ts(2), 'Snacks (fixed)', 1000, current_date,
  tests.u('b'), ARRAY[tests.u('a'), tests.u('b'), tests.u('e')])$$,
  'owner edits a former member''s expense, keeping the former payer and former participants');
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(tests.x(2), tests.ts(2), 'x', 1000, current_date,
  tests.u('e'), ARRAY[tests.u('a')])$$,
  'P0001', 'payer cannot change to a former member', 'invalid_payer');
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(tests.x(1), tests.ts(1), 'x', 1000, current_date,
  tests.u('a'), ARRAY[tests.u('a'), tests.u('e')])$$,
  'P0001', 'a former member who was not a participant cannot be added', 'invalid_participants');
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(tests.x(1), tests.ts(1), 'x', 1000, current_date,
  tests.u('a'), ARRAY[tests.u('a'), tests.u('d')])$$,
  'P0001', 'a member of another group cannot be pulled into the expense', 'invalid_participants');
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(tests.x(1), tests.ts(1), 'x', 1000, current_date,
  tests.u('c'), ARRAY[tests.u('a')])$$,
  'P0001', 'payer cannot change to an outsider', 'invalid_payer');
RESET ROLE;
SELECT tests.assert_eq(tests.splits(2), 'a=334 b=333 e=333', 'former members keep their recomputed shares');
SELECT tests.assert_eq((SELECT updated_by FROM public.expenses WHERE id = tests.x(2)), tests.u('a'), 'updated_by is the owner');
SET CONSTRAINTS ALL IMMEDIATE;
SELECT tests.assert(true, 'owner edit passes the deferred checks');
ROLLBACK;

-- Owner of G2 edits within G2; the group boundary holds -----------------------
BEGIN;
SELECT tests.login(tests.u('d'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok($$SELECT public.update_equal_split_expense(tests.x(3), tests.ts(3), 'Fuel', 3001, current_date,
  tests.u('d'), ARRAY[tests.u('c'), tests.u('a'), tests.u('d')])$$, 'G2 owner edits a G2 expense (adds himself, changes payer)');
SELECT tests.assert_raises($$SELECT public.update_equal_split_expense(tests.x(1), now(), 'x', 100, current_date, tests.u('d'), ARRAY[tests.u('d')])$$,
  'P0001', 'G2 owner cannot touch G1 expenses', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.assert_eq(tests.splits(3), 'a=1001 c=1000 d=1000', 'G2 splits recomputed canonically');
SELECT tests.assert_eq((SELECT group_id FROM public.expenses WHERE id = tests.x(3)),
  '10000000-0000-4000-8000-000000000002'::uuid, 'group unchanged');
ROLLBACK;

-- Every validation code on update (after authorization) -----------------------
BEGIN;
CREATE TEMP TABLE bad_calls (label text, args text, code text);
INSERT INTO bad_calls VALUES
  ('blank description',     $$'  ', 100, current_date, tests.u('b'), ARRAY[tests.u('b')]$$,                'invalid_description'),
  ('121-char description',  $$repeat('d', 121), 100, current_date, tests.u('b'), ARRAY[tests.u('b')]$$,    'invalid_description'),
  ('null amount',           $$'x', NULL, current_date, tests.u('b'), ARRAY[tests.u('b')]$$,                'invalid_amount'),
  ('zero amount',           $$'x', 0, current_date, tests.u('b'), ARRAY[tests.u('b')]$$,                   'invalid_amount'),
  ('amount above maximum',  $$'x', 1000000000000, current_date, tests.u('b'), ARRAY[tests.u('b')]$$,       'invalid_amount'),
  ('null date',             $$'x', 100, NULL, tests.u('b'), ARRAY[tests.u('b')]$$,                         'invalid_date'),
  ('null payer',            $$'x', 100, current_date, NULL, ARRAY[tests.u('b')]$$,                         'invalid_payer'),
  ('outsider payer',        $$'x', 100, current_date, tests.u('c'), ARRAY[tests.u('b')]$$,                 'invalid_payer'),
  ('null participants',     $$'x', 100, current_date, tests.u('b'), NULL$$,                                'invalid_participants'),
  ('empty participants',    $$'x', 100, current_date, tests.u('b'), ARRAY[]::uuid[]$$,                     'invalid_participants'),
  ('null element',          $$'x', 100, current_date, tests.u('b'), ARRAY[tests.u('b'), NULL]$$,           'invalid_participants'),
  ('duplicate participant', $$'x', 100, current_date, tests.u('b'), ARRAY[tests.u('b'), tests.u('b')]$$,   'invalid_participants'),
  ('outsider participant',  $$'x', 100, current_date, tests.u('b'), ARRAY[tests.u('b'), tests.u('c')]$$,   'invalid_participants'),
  ('too small to split',    $$'x', 2, current_date, tests.u('b'), ARRAY[tests.u('a'), tests.u('b'), tests.u('e')]$$, 'amount_too_small_to_split'),
  ('501-char notes',        $$'x', 100, current_date, tests.u('b'), ARRAY[tests.u('b')], repeat('n', 501)$$, 'invalid_notes');
GRANT SELECT ON bad_calls TO authenticated;
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM bad_calls LOOP
    PERFORM tests.assert_raises(
      format('SELECT public.update_equal_split_expense(tests.x(2), tests.ts(2), %s)', r.args),
      'P0001', 'creator update: ' || r.label || ' -> ' || r.code, r.code);
  END LOOP;
END
$$;
RESET ROLE;
SELECT tests.assert_eq(tests.splits(2), 'a=334 b=333 e=333', 'rejected updates change nothing');
ROLLBACK;

-- Delete -----------------------------------------------------------------------
BEGIN;
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok($$SELECT public.delete_expense(tests.x(2), tests.ts(2))$$, 'creator deletes their own expense');
SELECT tests.assert_raises($$SELECT public.delete_expense(tests.x(2), now())$$,
  'P0001', 'deleting it again -> not_found_or_forbidden', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.assert_eq((SELECT count(*) FROM public.expense_splits WHERE expense_id = tests.x(2)), 0::bigint,
  'its splits are removed with it');
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok($$SELECT public.delete_expense(tests.x(1), tests.ts(1))$$, 'owner deletes an expense in their group');
RESET ROLE;
SELECT tests.login(tests.u('d'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok($$SELECT public.delete_expense(tests.x(3), tests.ts(3))$$, 'G2 owner deletes a member''s expense in G2');
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT tests.assert_eq((SELECT count(*) FROM public.expenses), 0::bigint, 'deletions pass the deferred checks; ledger rows gone');
SELECT tests.assert_eq((SELECT count(*) FROM public.groups), 2::bigint, 'groups untouched by expense deletion');
ROLLBACK;
