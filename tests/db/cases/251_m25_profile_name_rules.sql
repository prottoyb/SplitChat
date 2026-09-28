-- M25: display-name rules (Phase 9, P15). Fixture users A-F (Alice ... Uma).

CREATE FUNCTION tests.u(letter text) RETURNS uuid LANGUAGE sql IMMUTABLE
  AS $f$ SELECT ('00000000-0000-4000-8000-00000000000' || letter)::uuid $f$;
CREATE FUNCTION tests.set_name(letter text, name text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM tests.login(tests.u(letter));
  SET LOCAL ROLE authenticated;
  UPDATE public.profiles SET full_name = name WHERE id = tests.u(letter);
  RESET ROLE;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RETURN SQLSTATE;
END $f$;
CREATE FUNCTION tests.name_of(id uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT full_name FROM public.profiles WHERE profiles.id = $1
$f$;
CREATE FUNCTION tests.sign_up(id uuid, email text, meta jsonb) RETURNS text LANGUAGE sql AS $f$
  INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES (id, email, meta, now());
  SELECT tests.name_of(id)
$f$;

-- Surface -------------------------------------------------------------------------
SELECT tests.assert((SELECT NOT convalidated FROM pg_constraint WHERE conname = 'profiles_full_name_check'),
  'the name rule is NOT VALID: existing rows are not checked or changed');

-- Editing my own name ---------------------------------------------------------------
SELECT tests.assert_eq(tests.set_name('a', 'Alice Adams'), 'ok', 'a normal name is accepted');
SELECT tests.assert_eq(tests.name_of(tests.u('a')), 'Alice Adams', 'and stored');
SELECT tests.assert_eq(tests.set_name('a', repeat('x', 80)), 'ok', 'an 80-character name is accepted');
SELECT tests.assert_eq(tests.set_name('a', repeat('x', 81)), '23514', 'an 81-character name is refused');
SELECT tests.assert_eq(tests.set_name('a', ''), '23514', 'an empty name is refused');
SELECT tests.assert_eq(tests.set_name('a', ' Alice'), '23514', 'an untrimmed name is refused (the client trims)');
SELECT tests.assert_eq(tests.set_name('a', 'Deleted user'), '23514', '"Deleted user" is reserved');
SELECT tests.assert_eq(tests.set_name('a', 'DELETED   USER'), '23514', 'in any case and spacing');
SELECT tests.assert_eq(tests.set_name('a', 'Deleted users'), 'ok', 'a different name that starts the same is fine');

-- Account deletion still writes the tombstone name --------------------------------
UPDATE public.profiles SET full_name = 'Deleted user', avatar_url = NULL, deleted_at = now() WHERE id = tests.u('f');
SELECT tests.assert_eq(tests.name_of(tests.u('f')), 'Deleted user', 'a tombstoned profile may carry the reserved name');

-- Existing rows that break the rule keep working until edited ----------------------
-- Simulate a row written before M25: lift the rule, write, restore it as M25 does.
DO $d$
DECLARE
  def text := pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'profiles_full_name_check'));
BEGIN
  ALTER TABLE public.profiles DROP CONSTRAINT profiles_full_name_check;
  UPDATE public.profiles SET full_name = '' WHERE id = tests.u('e');
  EXECUTE format('ALTER TABLE public.profiles ADD CONSTRAINT profiles_full_name_check %s', def);
END $d$;
SELECT tests.assert((SELECT NOT convalidated FROM pg_constraint WHERE conname = 'profiles_full_name_check'),
  'the restored rule is still NOT VALID');
SELECT tests.assert_eq(tests.name_of(tests.u('e')), '', 'a legacy blank name is left alone');
SELECT tests.assert_eq(tests.set_name('e', 'Eve'), 'ok', 'and can be fixed by its owner');

-- Sign-up cleans the name instead of failing ---------------------------------------
SELECT tests.assert_eq(tests.sign_up('00000000-0000-4000-8000-000000000101', 'zed@example.test', '{"full_name":"  Zed  "}'),
  'Zed', 'a sign-up name is trimmed');
SELECT tests.assert_eq(tests.sign_up('00000000-0000-4000-8000-000000000102', 'imp@example.test', '{"full_name":"Deleted User"}'),
  'imp', 'a reserved sign-up name falls back to the email''s local part');
SELECT tests.assert_eq(tests.sign_up('00000000-0000-4000-8000-000000000103', 'long@example.test', jsonb_build_object('full_name', repeat('y', 90))),
  repeat('y', 80), 'an over-long sign-up name is cut to 80 characters');
SELECT tests.assert_eq(tests.sign_up('00000000-0000-4000-8000-000000000104', 'blank@example.test', '{"full_name":"   "}'),
  'blank', 'a blank sign-up name falls back to the email''s local part');
SELECT tests.assert_eq(tests.sign_up('00000000-0000-4000-8000-000000000105', NULL, '{}'),
  'SplitChat member', 'no name and no email still signs up');
