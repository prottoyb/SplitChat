-- M24: owners rename a group / edit its description (Phase 9 D4, ADR-0013).
-- Fixture: G1 "Flat" owner A, members B, E; G2 "Trip" owner D, members C, A.
-- C and D are outsiders to G1.

CREATE FUNCTION tests.u(letter text) RETURNS uuid LANGUAGE sql IMMUTABLE
  AS $f$ SELECT ('00000000-0000-4000-8000-00000000000' || letter)::uuid $f$;
CREATE FUNCTION tests.g1() RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT '10000000-0000-4000-8000-000000000001'::uuid $f$;

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
CREATE FUNCTION tests.raises(letter text, sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM tests.as_user(letter, sql);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RETURN SQLERRM;
END $f$;
-- Unfiltered reads (definer) for assertions.
CREATE FUNCTION tests.grp() RETURNS public.groups LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT * FROM public.groups WHERE id = '10000000-0000-4000-8000-000000000001'
$f$;
CREATE FUNCTION tests.updates() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT count(*) FROM public.group_events WHERE kind = 'group_updated'
$f$;
CREATE FUNCTION tests.last_update() RETURNS public.group_events LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT * FROM public.group_events WHERE kind = 'group_updated' ORDER BY id DESC LIMIT 1
$f$;
CREATE FUNCTION tests.rename(letter text, name text, description text, expected timestamptz) RETURNS text LANGUAGE sql AS $f$
  SELECT tests.raises(letter, format('public.update_group_details(%L, %L, %L, %L)', tests.g1(), name, description, expected))
$f$;

-- Surface -------------------------------------------------------------------------
SELECT tests.assert((SELECT prosecdef FROM pg_proc WHERE oid = 'public.update_group_details(uuid, text, text, timestamptz)'::regprocedure),
  'update_group_details is SECURITY DEFINER');
SELECT tests.assert((SELECT proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid = 'public.update_group_details(uuid, text, text, timestamptz)'::regprocedure),
  'update_group_details pins an empty search_path');
SELECT tests.assert(has_function_privilege('authenticated', 'public.update_group_details(uuid, text, text, timestamptz)', 'EXECUTE'),
  'authenticated may call update_group_details');
SELECT tests.assert(NOT has_function_privilege('anon', 'public.update_group_details(uuid, text, text, timestamptz)', 'EXECUTE'),
  'anon may not call update_group_details');
SELECT tests.assert(NOT has_function_privilege('service_role', 'public.update_group_details(uuid, text, text, timestamptz)', 'EXECUTE'),
  'service_role holds no grant on update_group_details');
SELECT tests.assert(NOT has_table_privilege('authenticated', 'public.groups', 'UPDATE'),
  'clients still cannot UPDATE groups directly');

-- The owner renames ----------------------------------------------------------------
SELECT tests.assert_eq(tests.rename('a', '  Flat 4B  ', 'Rent and bills', (tests.grp()).updated_at), 'ok', 'the owner renames the group');
SELECT tests.assert_eq((tests.grp()).name, 'Flat 4B', 'the name is stored trimmed');
SELECT tests.assert_eq((tests.grp()).description, 'Rent and bills', 'the description is stored');
SELECT tests.assert_eq(tests.updates(), 1::bigint, 'one group_updated event');
SELECT tests.assert_eq((tests.last_update()).payload, '{"v": 1, "fields": ["name", "description"]}'::jsonb,
  'the event lists changed fields only, never the text');
SELECT tests.assert_eq((tests.last_update()).actor_id, tests.u('a'), 'the owner is the actor');
SELECT tests.assert_eq((tests.last_update()).people, ARRAY[tests.u('a')], 'the event involves only the actor');

-- Returns the new updated_at, which is the next expected value.
CREATE TEMP TABLE returned AS
  SELECT tests.as_user('a', format('public.update_group_details(%L, %L, %L, %L)', tests.g1(), 'Flat 4B', '   ', (tests.grp()).updated_at))::timestamptz AS at;
SELECT tests.assert_eq((SELECT at FROM returned), (tests.grp()).updated_at, 'returns the stored updated_at');
SELECT tests.assert((tests.grp()).description IS NULL, 'a blank description is stored as NULL');
SELECT tests.assert_eq((tests.last_update()).payload, '{"v": 1, "fields": ["description"]}'::jsonb, 'only the description changed');

-- An unchanged save writes nothing.
SELECT tests.assert_eq(tests.rename('a', 'Flat 4B', NULL, (tests.grp()).updated_at), 'ok', 'an unchanged save succeeds');
SELECT tests.assert_eq(tests.updates(), 2::bigint, 'an unchanged save records no event');

-- Optimistic concurrency ----------------------------------------------------------
SELECT tests.assert_eq(tests.rename('a', 'Somewhere else', NULL, (tests.grp()).updated_at - interval '1 second'), 'stale_group',
  'a save based on an older read is refused');
SELECT tests.assert_eq(tests.rename('a', 'Somewhere else', NULL, NULL), 'stale_group', 'a save without the read version is refused');
SELECT tests.assert_eq((tests.grp()).name, 'Flat 4B', 'a refused save changes nothing');

-- Validation ----------------------------------------------------------------------
SELECT tests.assert_eq(tests.rename('a', '   ', NULL, (tests.grp()).updated_at), 'invalid_name', 'a blank name is refused');
SELECT tests.assert_eq(tests.rename('a', repeat('x', 81), NULL, (tests.grp()).updated_at), 'invalid_name', 'an 81-character name is refused');
SELECT tests.assert_eq(tests.rename('a', repeat('x', 80), NULL, (tests.grp()).updated_at), 'ok', 'an 80-character name is accepted');
SELECT tests.assert_eq(tests.rename('a', 'Flat 4B', repeat('d', 301), (tests.grp()).updated_at), 'invalid_description',
  'a 301-character description is refused');

-- Authorization -------------------------------------------------------------------
SELECT tests.assert_eq(tests.rename('b', 'Mine now', NULL, (tests.grp()).updated_at), 'not_found_or_forbidden', 'a member cannot rename');
SELECT tests.assert_eq(tests.rename('c', 'Mine now', NULL, (tests.grp()).updated_at), 'not_found_or_forbidden', 'an outsider cannot rename');
SELECT tests.assert_eq(
  tests.raises('b', format('public.update_group_details(%L, %L, NULL, now())', '10000000-0000-4000-8000-000000000099', 'X')),
  'not_found_or_forbidden', 'an unknown group looks the same as a forbidden one');

CREATE FUNCTION tests.without_identity() RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM tests.logout();
  SET LOCAL ROLE authenticated;
  PERFORM public.update_group_details(tests.g1(), 'X', NULL, now());
  RESET ROLE;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RETURN SQLERRM;
END $f$;
SELECT tests.assert_eq(tests.without_identity(), 'auth_required', 'a call without an identity is refused');

-- A former owner loses the right under the same transaction as the transfer.
SELECT tests.as_user('a', format('public.transfer_group_ownership(%L, %L)', tests.g1(), tests.u('b')));
SELECT tests.assert_eq(tests.rename('a', 'Old owner', NULL, (tests.grp()).updated_at), 'not_found_or_forbidden', 'a former owner cannot rename');
SELECT tests.assert_eq(tests.rename('b', 'New owner’s flat', NULL, (tests.grp()).updated_at), 'ok', 'the new owner can rename');
SELECT tests.assert_eq((tests.grp()).name, 'New owner’s flat', 'the new owner''s name is stored');
