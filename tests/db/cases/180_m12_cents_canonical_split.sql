-- M12: integer cents, canonical equal split, create_equal_split_expense_v2
-- (ADR-0006, design §A7/§A8, tests F1, F8, F10, F11, S9 for v2).
-- Fixture: A owner of G1 (members B, E); D owner of G2 (members C, A).

-- Surface and grants ----------------------------------------------------------
SELECT tests.assert(has_function_privilege('authenticated',
  'public.create_equal_split_expense_v2(uuid,text,bigint,date,uuid,uuid[],text)', 'EXECUTE'), 'authenticated can execute v2');
SELECT tests.assert(NOT has_function_privilege('anon',
  'public.create_equal_split_expense_v2(uuid,text,bigint,date,uuid,uuid[],text)', 'EXECUTE'), 'anon cannot execute v2');
SELECT tests.assert(NOT has_function_privilege('service_role',
  'public.create_equal_split_expense_v2(uuid,text,bigint,date,uuid,uuid[],text)', 'EXECUTE'), 'service_role has no v2 grant');
SELECT tests.assert(NOT has_function_privilege('authenticated', 'private.equal_split_cents(bigint,uuid[])', 'EXECUTE'),
  'authenticated cannot call the allocation function directly');
SELECT tests.assert((SELECT prosecdef AND proconfig = ARRAY['search_path=""'] FROM pg_proc
                      WHERE oid = 'public.create_equal_split_expense_v2(uuid,text,bigint,date,uuid,uuid[],text)'::regprocedure),
  'v2 is SECURITY DEFINER with an empty search_path');
SELECT tests.assert((SELECT provolatile = 'i' FROM pg_proc WHERE oid = 'private.equal_split_cents(bigint,uuid[])'::regprocedure),
  'equal_split_cents is IMMUTABLE');

-- Generated cents columns (F10, CA-3) -------------------------------------------
SELECT tests.assert_eq((SELECT attgenerated::text FROM pg_attribute
                         WHERE attrelid = 'public.expenses'::regclass AND attname = 'amount_cents'), 's', 'amount_cents is a stored generated column');
SELECT tests.assert_eq((SELECT attgenerated::text FROM pg_attribute
                         WHERE attrelid = 'public.expense_splits'::regclass AND attname = 'share_cents'), 's', 'share_cents is a stored generated column');
SELECT tests.assert_eq((SELECT array_agg(amount_cents ORDER BY id) FROM public.expenses),
  ARRAY[10000, 1000, 3000]::bigint[], 'seeded expenses expose exact cents');
SELECT tests.assert_eq((SELECT array_agg(share_cents ORDER BY user_id) FROM public.expense_splits
                         WHERE expense_id = '20000000-0000-4000-8000-000000000002'),
  ARRAY[334, 333, 333]::bigint[], 'seeded splits expose exact cents');
SELECT tests.assert(NOT EXISTS (
  SELECT 1 FROM public.expenses e
   WHERE e.amount_cents::numeric <> e.amount * 100
      OR e.amount_cents <> (SELECT sum(s.share_cents) FROM public.expense_splits s WHERE s.expense_id = e.id)),
  'every expense: amount_cents = amount*100 = sum(share_cents)');
BEGIN;
SET LOCAL ROLE postgres;
SELECT tests.assert_raises($$UPDATE public.expenses SET amount_cents = 1 WHERE id = '20000000-0000-4000-8000-000000000001'$$,
  '428C9', 'amount_cents cannot be written directly');
ROLLBACK;

-- Shared vectors against the database allocation function (F1) --------------
SELECT tests.assert((SELECT count(*) >= 15 FROM tests.split_vectors), 'shared split vectors loaded');
DO $$
DECLARE
  v record;
  got jsonb;
  got_state text;
  got_error text;
BEGIN
  FOR v IN SELECT * FROM tests.split_vectors ORDER BY name LOOP
    got := NULL; got_state := NULL; got_error := NULL;
    BEGIN
      SELECT jsonb_agg(jsonb_build_object('userId', s.user_id::text, 'shareCents', s.share_cents) ORDER BY s.user_id)
        INTO got
        FROM private.equal_split_cents(v.total_cents, v.participant_ids::uuid[]) s;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS got_state = RETURNED_SQLSTATE, got_error = MESSAGE_TEXT;
    END;
    IF v.error IS NOT NULL THEN
      PERFORM tests.assert_eq(got_state || ' ' || got_error, 'P0001 ' || v.error, 'equal_split_cents vector: ' || v.name);
    ELSE
      PERFORM tests.assert_eq(coalesce(got_error, 'ok'), 'ok', 'equal_split_cents vector runs: ' || v.name);
      PERFORM tests.assert_eq(got, v.expected, 'equal_split_cents vector: ' || v.name);
    END IF;
  END LOOP;
END
$$;
SELECT tests.assert_raises($$SELECT * FROM private.equal_split_cents(10, ARRAY[NULL]::uuid[])$$,
  'P0001', 'null participant element rejected', 'invalid_participants');
SELECT tests.assert_raises($$SELECT * FROM private.equal_split_cents(10, NULL)$$,
  'P0001', 'null participant array rejected', 'invalid_participants');
SELECT tests.assert_raises($$SELECT * FROM private.equal_split_cents(NULL, ARRAY['00000000-0000-4000-8000-00000000000a']::uuid[])$$,
  'P0001', 'null total rejected', 'invalid_amount');

-- Shared vectors end to end through v2 (F1) -----------------------------------
-- Every vector id becomes a member of a fresh group owned by Alice; Alice
-- records each vector's expense with the ids in the vector's input order.
BEGIN;
INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at)
SELECT id, 'v' || replace(id::text, '-', '') || '@example.test', '{"full_name":"Vector"}', now()
  FROM (SELECT DISTINCT p::uuid AS id FROM tests.split_vectors, unnest(participant_ids) AS p) ids;
INSERT INTO public.groups (id, name, created_by)
VALUES ('10000000-0000-4000-8000-0000000000f1', 'Vectors', '00000000-0000-4000-8000-00000000000a');
INSERT INTO public.group_members (group_id, user_id, role)
SELECT '10000000-0000-4000-8000-0000000000f1', id, 'member'
  FROM (SELECT DISTINCT p::uuid AS id FROM tests.split_vectors, unnest(participant_ids) AS p) ids;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v record;
  v_id uuid;
  got jsonb;
  got_state text;
  got_error text;
  has_duplicates boolean;
BEGIN
  FOR v IN SELECT * FROM tests.split_vectors ORDER BY name LOOP
    v_id := NULL; got_state := NULL; got_error := NULL;
    has_duplicates := cardinality(v.participant_ids)
                      <> (SELECT count(DISTINCT lower(p)) FROM unnest(v.participant_ids) AS p);
    BEGIN
      v_id := public.create_equal_split_expense_v2('10000000-0000-4000-8000-0000000000f1', 'Vector ' || left(v.name, 100),
        v.total_cents, current_date, '00000000-0000-4000-8000-00000000000a', v.participant_ids::uuid[]);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS got_state = RETURNED_SQLSTATE, got_error = MESSAGE_TEXT;
    END;
    IF has_duplicates THEN
      -- v2 is strict: duplicates are a client bug, not silently merged.
      PERFORM tests.assert_eq(got_state || ' ' || got_error, 'P0001 invalid_participants', 'v2 vector (duplicates rejected): ' || v.name);
    ELSIF v.error IS NOT NULL THEN
      PERFORM tests.assert_eq(got_state || ' ' || got_error, 'P0001 ' || v.error, 'v2 vector: ' || v.name);
    ELSE
      PERFORM tests.assert_eq(coalesce(got_error, 'ok'), 'ok', 'v2 vector runs: ' || v.name);
      SELECT jsonb_agg(jsonb_build_object('userId', s.user_id::text, 'shareCents', s.share_cents) ORDER BY s.user_id)
        INTO got FROM public.expense_splits s WHERE s.expense_id = v_id;
      PERFORM tests.assert_eq(got, v.expected, 'v2 vector: ' || v.name);
      PERFORM tests.assert_eq((SELECT amount_cents FROM public.expenses WHERE id = v_id), v.total_cents,
        'v2 vector amount_cents: ' || v.name);
    END IF;
  END LOOP;
END
$$;
ROLLBACK;

-- v2 happy path ---------------------------------------------------------------
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000b');
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE v2_expense AS
SELECT public.create_equal_split_expense_v2('10000000-0000-4000-8000-000000000001', '  Pizza  ', 1000, DATE '2026-09-20',
  '00000000-0000-4000-8000-00000000000a',
  ARRAY['00000000-0000-4000-8000-00000000000e', '00000000-0000-4000-8000-00000000000b',
        '00000000-0000-4000-8000-00000000000a']::uuid[], '  thin crust  ') AS id;
SELECT tests.assert_eq(
  (SELECT row(group_id, description, amount, amount_cents, expense_date, paid_by, created_by, split_type, notes)::text
     FROM public.expenses WHERE id = (SELECT id FROM v2_expense)),
  row('10000000-0000-4000-8000-000000000001'::uuid, 'Pizza', 10.00::numeric, 1000::bigint, DATE '2026-09-20',
      '00000000-0000-4000-8000-00000000000a'::uuid, '00000000-0000-4000-8000-00000000000b'::uuid, 'equal', 'thin crust')::text,
  'v2 stores trimmed text, exact amount, caller as creator, equal split');
SELECT tests.assert_eq(
  (SELECT array_agg(user_id::text || '=' || share_cents ORDER BY user_id) FROM public.expense_splits
    WHERE expense_id = (SELECT id FROM v2_expense)),
  ARRAY['00000000-0000-4000-8000-00000000000a=334', '00000000-0000-4000-8000-00000000000b=333',
        '00000000-0000-4000-8000-00000000000e=333'],
  'v2 gives the remainder cent to the lowest UUID regardless of input order');
SELECT tests.assert_eq(
  (SELECT notes FROM public.expenses
    WHERE id = public.create_equal_split_expense_v2('10000000-0000-4000-8000-000000000001', 'Blank notes', 5,
      current_date, '00000000-0000-4000-8000-00000000000b', ARRAY['00000000-0000-4000-8000-00000000000b']::uuid[], '   ')),
  NULL::text, 'blank notes are stored as NULL');
SELECT tests.assert_ok($$SELECT public.create_equal_split_expense_v2('10000000-0000-4000-8000-000000000001', repeat('d', 120),
  999999999999, current_date, '00000000-0000-4000-8000-00000000000b', ARRAY['00000000-0000-4000-8000-00000000000b']::uuid[],
  repeat('n', 500))$$, 'v2 accepts the limits: 120-char description, 500-char notes, maximum amount');
ROLLBACK;

-- Legacy wrapper and v2 produce identical splits (F11) -------------------------
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE pair AS
SELECT public.create_equal_split_expense('10000000-0000-4000-8000-000000000001', 'Legacy', 100.01, current_date,
         '00000000-0000-4000-8000-00000000000a',
         ARRAY['00000000-0000-4000-8000-00000000000e', '00000000-0000-4000-8000-00000000000b',
               '00000000-0000-4000-8000-00000000000a']::uuid[]) AS legacy_id,
       public.create_equal_split_expense_v2('10000000-0000-4000-8000-000000000001', 'V2', 10001, current_date,
         '00000000-0000-4000-8000-00000000000a',
         ARRAY['00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000a',
               '00000000-0000-4000-8000-00000000000e']::uuid[]) AS v2_id;
SELECT tests.assert_eq(
  (SELECT array_agg(user_id::text || '=' || share_cents ORDER BY user_id) FROM public.expense_splits
    WHERE expense_id = (SELECT legacy_id FROM pair)),
  (SELECT array_agg(user_id::text || '=' || share_cents ORDER BY user_id) FROM public.expense_splits
    WHERE expense_id = (SELECT v2_id FROM pair)),
  'legacy wrapper and v2 allocate identically');
ROLLBACK;

-- Every v2 error code (F8), authorization first (DS-1) -------------------------
BEGIN;
SELECT tests.logout();
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.create_equal_split_expense_v2('10000000-0000-4000-8000-000000000001', '', NULL,
  NULL, NULL, NULL)$$, 'P0001', 'no session -> auth_required before anything else', 'auth_required');
RESET ROLE;

SELECT tests.login('00000000-0000-4000-8000-00000000000c');  -- Cara: outsider to G1
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.create_equal_split_expense_v2('10000000-0000-4000-8000-000000000001', 'x', 100,
  current_date, '00000000-0000-4000-8000-00000000000c', ARRAY['00000000-0000-4000-8000-00000000000c']::uuid[])$$,
  'P0001', 'outsider, existing group -> not_found_or_forbidden', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.create_equal_split_expense_v2('10000000-0000-4000-8000-0000000000ff', 'x', 100,
  current_date, '00000000-0000-4000-8000-00000000000c', ARRAY['00000000-0000-4000-8000-00000000000c']::uuid[])$$,
  'P0001', 'outsider, nonexistent group -> identical not_found_or_forbidden (S9)', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.create_equal_split_expense_v2(NULL, 'x', 100,
  current_date, '00000000-0000-4000-8000-00000000000c', ARRAY['00000000-0000-4000-8000-00000000000c']::uuid[])$$,
  'P0001', 'null group -> not_found_or_forbidden', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.create_equal_split_expense_v2('10000000-0000-4000-8000-000000000001', '', -5,
  NULL, NULL, NULL, repeat('n', 900))$$,
  'P0001', 'outsider with every argument invalid still gets only not_found_or_forbidden', 'not_found_or_forbidden');
RESET ROLE;

-- u('b') is fixture user …0b (a..f = Alice, Bob, Cara, Dan, Eve, Uma).
CREATE FUNCTION tests.u(letter text) RETURNS uuid LANGUAGE sql IMMUTABLE
  AS $f$ SELECT ('00000000-0000-4000-8000-00000000000' || letter)::uuid $f$;
CREATE TEMP TABLE bad_calls (label text, args text, code text);
INSERT INTO bad_calls VALUES
  ('blank description',        $$'   ', 100, current_date, tests.u('b'), ARRAY[tests.u('b')]$$,        'invalid_description'),
  ('null description',         $$NULL, 100, current_date, tests.u('b'), ARRAY[tests.u('b')]$$,         'invalid_description'),
  ('121-char description',     $$repeat('d', 121), 100, current_date, tests.u('b'), ARRAY[tests.u('b')]$$, 'invalid_description'),
  ('description checked before amount', $$'', 0, NULL, NULL, NULL$$,                                   'invalid_description'),
  ('null amount',              $$'x', NULL, current_date, tests.u('b'), ARRAY[tests.u('b')]$$,         'invalid_amount'),
  ('zero amount',              $$'x', 0, current_date, tests.u('b'), ARRAY[tests.u('b')]$$,            'invalid_amount'),
  ('negative amount',          $$'x', -1, current_date, tests.u('b'), ARRAY[tests.u('b')]$$,           'invalid_amount'),
  ('amount above maximum',     $$'x', 1000000000000, current_date, tests.u('b'), ARRAY[tests.u('b')]$$, 'invalid_amount'),
  ('null date',                $$'x', 100, NULL, tests.u('b'), ARRAY[tests.u('b')]$$,                  'invalid_date'),
  ('null payer',               $$'x', 100, current_date, NULL, ARRAY[tests.u('b')]$$,                  'invalid_payer'),
  ('outsider payer',           $$'x', 100, current_date, tests.u('c'), ARRAY[tests.u('b')]$$,          'invalid_payer'),
  ('unconfirmed non-member payer', $$'x', 100, current_date, tests.u('f'), ARRAY[tests.u('b')]$$,      'invalid_payer'),
  ('null participants',        $$'x', 100, current_date, tests.u('b'), NULL$$,                         'invalid_participants'),
  ('empty participants',       $$'x', 100, current_date, tests.u('b'), ARRAY[]::uuid[]$$,              'invalid_participants'),
  ('null participant element', $$'x', 100, current_date, tests.u('b'), ARRAY[tests.u('b'), NULL]$$,    'invalid_participants'),
  ('duplicate participant',    $$'x', 100, current_date, tests.u('b'), ARRAY[tests.u('b'), tests.u('b')]$$, 'invalid_participants'),
  ('outsider participant',     $$'x', 100, current_date, tests.u('b'), ARRAY[tests.u('b'), tests.u('c')]$$, 'invalid_participants'),
  ('too small to split',       $$'x', 2, current_date, tests.u('b'), ARRAY[tests.u('a'), tests.u('b'), tests.u('e')]$$, 'amount_too_small_to_split'),
  ('501-char notes',           $$'x', 100, current_date, tests.u('b'), ARRAY[tests.u('b')], repeat('n', 501)$$, 'invalid_notes');
GRANT SELECT ON bad_calls TO authenticated;
SELECT tests.login('00000000-0000-4000-8000-00000000000b');  -- Bob: active member of G1
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM bad_calls LOOP
    PERFORM tests.assert_raises(
      format('SELECT public.create_equal_split_expense_v2(%L, %s)', '10000000-0000-4000-8000-000000000001', r.args),
      'P0001', 'member: ' || r.label || ' -> ' || r.code, r.code);
  END LOOP;
END
$$;
RESET ROLE;

-- Former member E (left G1): no longer authorized, and cannot be named as payer
-- or participant of a new expense.
UPDATE public.group_members SET left_at = now(), left_reason = 'left'
 WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000e';
SELECT tests.login('00000000-0000-4000-8000-00000000000e');
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.create_equal_split_expense_v2('10000000-0000-4000-8000-000000000001', 'x', 100,
  current_date, '00000000-0000-4000-8000-00000000000e', ARRAY['00000000-0000-4000-8000-00000000000e']::uuid[])$$,
  'P0001', 'former member caller -> not_found_or_forbidden', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.login('00000000-0000-4000-8000-00000000000a');
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.create_equal_split_expense_v2('10000000-0000-4000-8000-000000000001', 'x', 100,
  current_date, '00000000-0000-4000-8000-00000000000e', ARRAY['00000000-0000-4000-8000-00000000000a']::uuid[])$$,
  'P0001', 'former member as payer -> invalid_payer', 'invalid_payer');
SELECT tests.assert_raises($$SELECT public.create_equal_split_expense_v2('10000000-0000-4000-8000-000000000001', 'x', 100,
  current_date, '00000000-0000-4000-8000-00000000000a',
  ARRAY['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000e']::uuid[])$$,
  'P0001', 'former member as participant -> invalid_participants', 'invalid_participants');
-- Cross-group: a member of G2 who is not in G1 cannot be pulled into a G1 expense.
SELECT tests.assert_raises($$SELECT public.create_equal_split_expense_v2('10000000-0000-4000-8000-000000000001', 'x', 100,
  current_date, '00000000-0000-4000-8000-00000000000a',
  ARRAY['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000d']::uuid[])$$,
  'P0001', 'member of another group as participant -> invalid_participants', 'invalid_participants');
ROLLBACK;

-- Nothing above committed: the seeded ledger is unchanged.
SELECT tests.assert_eq((SELECT count(*) FROM public.expenses), 3::bigint, 'seeded ledger unchanged by the case');
