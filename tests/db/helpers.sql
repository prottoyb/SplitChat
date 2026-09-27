-- Test-only assertion helpers (schema `tests`). Loaded by scripts/db-test.mjs
-- after migrations; never part of a migration. Every assertion that passes
-- emits NOTICE 'ok: <message>'; a failure raises and aborts the case file.

CREATE SCHEMA tests;
GRANT USAGE ON SCHEMA tests TO PUBLIC;

CREATE FUNCTION tests.assert(condition boolean, message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ASSERTION FAILED: %', message;
  END IF;
  RAISE NOTICE 'ok: %', message;
END
$$;

CREATE FUNCTION tests.assert_eq(actual anyelement, expected anyelement, message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % (expected %, got %)', message, expected, actual;
  END IF;
  RAISE NOTICE 'ok: %', message;
END
$$;

-- Runs `statement` as the current role; asserts it raises `expected_sqlstate`
-- and, when given, an error message equal to `expected_message`.
CREATE FUNCTION tests.assert_raises(
  statement text, expected_sqlstate text, message text,
  expected_message text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  got_state text;
  got_message text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS got_state = RETURNED_SQLSTATE, got_message = MESSAGE_TEXT;
  END;
  IF got_state IS NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % (expected error %, statement succeeded)', message, expected_sqlstate;
  END IF;
  IF got_state <> expected_sqlstate
     OR (expected_message IS NOT NULL AND got_message IS DISTINCT FROM expected_message) THEN
    RAISE EXCEPTION 'ASSERTION FAILED: % (expected % %, got % %)',
      message, expected_sqlstate, coalesce(expected_message, ''), got_state, got_message;
  END IF;
  RAISE NOTICE 'ok: %', message;
END
$$;

-- Runs `statement` and asserts it succeeds.
CREATE FUNCTION tests.assert_ok(statement text, message text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  got_state text;
  got_message text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS got_state = RETURNED_SQLSTATE, got_message = MESSAGE_TEXT;
    RAISE EXCEPTION 'ASSERTION FAILED: % (unexpected error % %)', message, got_state, got_message;
  END;
  RAISE NOTICE 'ok: %', message;
END
$$;

-- Simulates a PostgREST request identity for the rest of the transaction.
CREATE FUNCTION tests.login(user_id uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    json_build_object('sub', user_id, 'role', 'authenticated')::text, true);
  SELECT set_config('request.jwt.claim.sub', user_id::text, true);
$$;

CREATE FUNCTION tests.logout() RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', '', true);
  SELECT set_config('request.jwt.claim.sub', '', true);
$$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA tests TO PUBLIC;
