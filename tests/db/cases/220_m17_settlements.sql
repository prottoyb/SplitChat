-- M17: settlements and server-authoritative balances (ADR-0010).
-- Fixture balances in cents: G1 A +4666, B -4333, E -333 (owner A);
-- G2 C +1500, A -1500 (owner D).

CREATE FUNCTION tests.u(letter text) RETURNS uuid LANGUAGE sql IMMUTABLE
  AS $f$ SELECT ('00000000-0000-4000-8000-00000000000' || letter)::uuid $f$;
CREATE FUNCTION tests.g1() RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT '10000000-0000-4000-8000-000000000001'::uuid $f$;
CREATE FUNCTION tests.g2() RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT '10000000-0000-4000-8000-000000000002'::uuid $f$;
-- Unfiltered views of the ledger (definer), for assertions made as any role.
CREATE FUNCTION tests.net(g uuid, letter text) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT coalesce((SELECT net_cents FROM private.group_balances(g) WHERE user_id = tests.u(letter)), 0::bigint)
$f$;
CREATE FUNCTION tests.total(g uuid) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT coalesce(sum(net_cents), 0)::bigint FROM private.group_balances(g)
$f$;
CREATE FUNCTION tests.settlement_count() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT count(*) FROM public.settlements
$f$;
CREATE TABLE tests.event_baseline AS SELECT coalesce(max(id), 0) AS id FROM public.group_events;
GRANT SELECT ON tests.event_baseline TO PUBLIC;
CREATE FUNCTION tests.new_events() RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT coalesce(array_agg(kind || ':' || coalesce(right(actor_id::text, 1), '-') ORDER BY id), '{}')
    FROM public.group_events WHERE id > (SELECT id FROM tests.event_baseline)
$f$;
CREATE FUNCTION tests.last_payload() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT payload FROM public.group_events ORDER BY id DESC LIMIT 1
$f$;

-- Surface --------------------------------------------------------------------
SELECT tests.assert((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.settlements'::regclass), 'RLS on settlements');
SELECT tests.assert(has_table_privilege('authenticated', 'public.settlements', 'SELECT'), 'members can read settlements (RLS-filtered)');
SELECT tests.assert(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p
                                 WHERE has_table_privilege('authenticated', 'public.settlements', p)),
  'clients cannot write settlements');
SELECT tests.assert(NOT has_table_privilege('anon', 'public.settlements', 'SELECT'), 'anon cannot read settlements');
SELECT tests.assert(
  has_function_privilege('authenticated', 'public.record_settlement(uuid,uuid,uuid,bigint,date,text,uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.void_settlement(uuid,text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.get_group_balances(uuid)', 'EXECUTE'),
  'members can call the settlement RPCs');
SELECT tests.assert(NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY['public.record_settlement(uuid,uuid,uuid,bigint,date,text,uuid)',
                               'public.void_settlement(uuid,text)', 'public.get_group_balances(uuid)']) f
     WHERE has_function_privilege('anon', f, 'EXECUTE')),
  'anon cannot call them');
SELECT tests.assert(NOT EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
                                 WHERE has_function_privilege(r, 'private.group_balances(uuid)', 'EXECUTE')),
  'the unauthorised balance helper is private');

-- Balances -----------------------------------------------------------------------
BEGIN;
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq(
  (SELECT array_agg(right(user_id::text, 1) || ':' || paid_cents || '/' || owed_cents || '/' || net_cents ORDER BY user_id)
     FROM public.get_group_balances(tests.g1())),
  ARRAY['a:10000/5334/4666', 'b:1000/5333/-4333', 'e:0/333/-333'],
  'balances: paid, owed and net per person, in cents');
SELECT tests.assert_raises($$SELECT * FROM public.get_group_balances(tests.g2())$$, 'P0001',
  'balances of a group the caller is not in are refused', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.logout();
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT * FROM public.get_group_balances(tests.g1())$$, 'P0001',
  'no identity, no balances', 'auth_required');
RESET ROLE;
ROLLBACK;

-- Partial settlements chain to zero; no over-settlement, no reversal ----------------
BEGIN;
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE first_settlement AS
SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 1000, DATE '2026-09-20', '  Cash  ') AS id;
RESET ROLE;
SELECT tests.assert_eq(tests.net(tests.g1(), 'b'), -3333::bigint, 'a partial settlement reduces the debt');
SELECT tests.assert_eq(tests.net(tests.g1(), 'a'), 3666::bigint, 'and the credit by the same cents');
SELECT tests.assert_eq(tests.total(tests.g1()), 0::bigint, 'the group still nets to zero');
SELECT tests.assert_eq((SELECT note FROM public.settlements WHERE id = (SELECT id FROM first_settlement)), 'Cash', 'the note is trimmed');
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 3334, current_date)$$,
  'P0001', 'more than the remaining debt is refused', 'exceeds_balance');
SELECT tests.assert_ok($$SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 3333, current_date)$$,
  'the exact remainder is accepted');
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 1, current_date)$$,
  'P0001', 'a settled debtor has nothing to settle', 'nothing_to_settle');
RESET ROLE;
SELECT tests.assert_eq(tests.net(tests.g1(), 'b'), 0::bigint, 'B is settled');
SELECT tests.login(tests.u('e'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('e'), tests.u('a'), 334, current_date)$$,
  'P0001', 'the payer cannot pay more than they owe', 'exceeds_balance');
SELECT tests.assert_ok($$SELECT public.record_settlement(tests.g1(), tests.u('e'), tests.u('a'), 333, current_date)$$,
  'E settles in full');
RESET ROLE;
SELECT tests.assert_eq(
  ARRAY[tests.net(tests.g1(), 'a'), tests.net(tests.g1(), 'b'), tests.net(tests.g1(), 'e'), tests.total(tests.g1())],
  ARRAY[0, 0, 0, 0]::bigint[], 'everyone in G1 is settled up');
SELECT tests.assert_eq(tests.new_events(), ARRAY['settlement_recorded:b', 'settlement_recorded:b', 'settlement_recorded:e'],
  'one settlement_recorded per successful call, none for refused ones');
SELECT tests.assert_eq(tests.last_payload() - 'v',
  jsonb_build_object('amount_cents', 333, 'settled_on', current_date, 'from_user', tests.u('e'), 'to_user', tests.u('a')),
  'settlement event: cents, date and parties only');
ROLLBACK;

BEGIN;
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('a'), tests.u('b'), 100, current_date)$$,
  'P0001', 'a creditor paying a debtor (debt reversal) is refused', 'nothing_to_settle');
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('e'), tests.u('b'), 100, current_date)$$,
  'P0001', 'paying someone who is not owed is refused', 'nothing_to_settle');
RESET ROLE;
ROLLBACK;

-- Input validation -----------------------------------------------------------------
BEGIN;
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 0, current_date)$$, 'P0001', 'zero amount', 'invalid_amount');
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), -5, current_date)$$, 'P0001', 'negative amount', 'invalid_amount');
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), NULL, current_date)$$, 'P0001', 'missing amount', 'invalid_amount');
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 1000000000000, current_date)$$, 'P0001', 'amount above the ceiling', 'invalid_amount');
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 1, DATE '1999-12-31')$$, 'P0001', 'date before 2000', 'invalid_date');
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 1, current_date + 367)$$, 'P0001', 'date more than a year ahead', 'invalid_date');
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 1, NULL)$$, 'P0001', 'missing date', 'invalid_date');
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 1, current_date, repeat('n', 201))$$, 'P0001', 'note over 200 characters', 'invalid_note');
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('b'), 1, current_date)$$, 'P0001', 'paying yourself', 'invalid_parties');
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('c'), 1, current_date)$$, 'P0001', 'a payee who was never in the group', 'invalid_parties');
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), NULL, tests.u('a'), 1, current_date)$$, 'P0001', 'a missing payer', 'invalid_parties');
CREATE TEMP TABLE blank_note AS SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 200, current_date + 366, '   ') AS id;
RESET ROLE;
SELECT tests.assert((SELECT note IS NULL FROM public.settlements WHERE id = (SELECT id FROM blank_note)),
  'a blank note is stored as no note; a date a year ahead is accepted');
SELECT tests.assert_eq(tests.new_events(), ARRAY['settlement_recorded:b'], 'refused calls recorded no event');
ROLLBACK;

-- Permissions: parties or the owner; former and deleted members ----------------------
BEGIN;
SELECT tests.login(tests.u('e'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 100, current_date)$$,
  'P0001', 'a member who is not a party cannot record for others', 'forbidden');
RESET ROLE;
SELECT tests.login(tests.u('c'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 100, current_date)$$,
  'P0001', 'an outsider is refused as if the group did not exist', 'not_found_or_forbidden');
RESET ROLE;
-- G2: the owner D records a payment between two other members.
SELECT tests.login(tests.u('d'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok($$SELECT public.record_settlement(tests.g2(), tests.u('a'), tests.u('c'), 500, current_date)$$,
  'the owner may record a payment between two other members');
RESET ROLE;
-- E leaves G1 while still owing: the debt remains and can still be settled.
UPDATE public.group_members SET left_at = now(), left_reason = 'left' WHERE group_id = tests.g1() AND user_id = tests.u('e');
SELECT tests.assert_eq(tests.net(tests.g1(), 'e'), -333::bigint, 'a former member keeps their balance');
SELECT tests.login(tests.u('e'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('e'), tests.u('a'), 333, current_date)$$,
  'P0001', 'a former member can no longer act in the group', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok($$SELECT public.record_settlement(tests.g1(), tests.u('e'), tests.u('a'), 333, current_date)$$,
  'a current member can settle with a former member');
RESET ROLE;
-- C deletes their account; A can still pay C.
SET LOCAL ROLE supabase_auth_admin;
DELETE FROM auth.users WHERE id = tests.u('c');
RESET ROLE;
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok($$SELECT public.record_settlement(tests.g2(), tests.u('a'), tests.u('c'), 1000, current_date)$$,
  'a debt to a deleted account can still be settled');
SELECT tests.assert_eq((SELECT display_name FROM public.get_ledger_identities(tests.g2()) WHERE user_id = tests.u('c')),
  'Deleted user', 'the deleted payee is named by the ledger identities');
RESET ROLE;
SELECT tests.assert_eq(ARRAY[tests.net(tests.g2(), 'a'), tests.net(tests.g2(), 'c'), tests.total(tests.g2())],
  ARRAY[0, 0, 0]::bigint[], 'G2 settled; still nets to zero');
ROLLBACK;

-- Idempotent retry ---------------------------------------------------------------------
BEGIN;
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE tries AS
SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 700, DATE '2026-09-21', 'x',
                                'aaaaaaaa-0000-4000-8000-000000000001') AS id;
INSERT INTO tries
SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 700, DATE '2026-09-21', 'x ',
                                'aaaaaaaa-0000-4000-8000-000000000001');
SELECT tests.assert_raises($$SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 800, DATE '2026-09-21', 'x',
                                'aaaaaaaa-0000-4000-8000-000000000001')$$,
  'P0001', 'the same request id with different details is refused', 'duplicate_request');
RESET ROLE;
SELECT tests.assert_eq((SELECT count(DISTINCT id) FROM tries), 1::bigint, 'a retried request returns the same settlement');
SELECT tests.assert_eq(tests.settlement_count(), 1::bigint, 'and writes it once');
SELECT tests.assert_eq(tests.net(tests.g1(), 'b'), -3633::bigint, 'the balance moved once');
ROLLBACK;

-- Voiding ---------------------------------------------------------------------------
BEGIN;
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE s AS SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 1000, current_date) AS id;
RESET ROLE;
SELECT tests.login(tests.u('e'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.void_settlement((SELECT id FROM s), 'no')$$, 'P0001',
  'a member who is neither party nor owner cannot void', 'forbidden');
RESET ROLE;
SELECT tests.login(tests.u('c'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.void_settlement((SELECT id FROM s), 'no')$$, 'P0001',
  'an outsider cannot void', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.void_settlement('aaaaaaaa-0000-4000-8000-00000000ffff', 'no')$$, 'P0001',
  'an unknown settlement looks the same', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.void_settlement((SELECT id FROM s), '   ')$$, 'P0001', 'a reason is required', 'invalid_reason');
SELECT tests.assert_raises($$SELECT public.void_settlement((SELECT id FROM s), repeat('r', 201))$$, 'P0001', 'reason at most 200', 'invalid_reason');
SELECT tests.assert_ok($$SELECT public.void_settlement((SELECT id FROM s), ' Recorded twice ')$$, 'a party can void');
SELECT tests.assert_raises($$SELECT public.void_settlement((SELECT id FROM s), 'again')$$, 'P0001', 'only once', 'already_voided');
SELECT tests.assert_eq((SELECT count(*) FROM public.settlements WHERE id = (SELECT id FROM s) AND voided_by = tests.u('b')
                                                              AND void_reason = 'Recorded twice'), 1::bigint,
  'the voided settlement stays visible, with who and why');
RESET ROLE;
SELECT tests.assert_eq(tests.net(tests.g1(), 'b'), -4333::bigint, 'voiding restores the debt');
SELECT tests.assert_eq((tests.new_events())[2], 'settlement_voided:b', 'voiding records settlement_voided');
SELECT tests.assert(tests.last_payload()::text !~ 'Recorded twice', 'the reason is not in the event');
-- The owner can void a payment between others.
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE s2 AS SELECT public.record_settlement(tests.g2(), tests.u('a'), tests.u('c'), 100, current_date) AS id;
RESET ROLE;
SELECT tests.login(tests.u('d'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok($$SELECT public.void_settlement((SELECT id FROM s2), 'Wrong group')$$, 'the owner can void');
RESET ROLE;
ROLLBACK;

-- Readers, direct writes and database backstops --------------------------------------
BEGIN;
SELECT tests.login(tests.u('b'));
SET LOCAL ROLE authenticated;
SELECT public.record_settlement(tests.g1(), tests.u('b'), tests.u('a'), 1000, current_date);
SELECT tests.assert_eq((SELECT count(*) FROM public.settlements), 1::bigint, 'a member reads their group''s settlements');
SELECT tests.assert_raises($$INSERT INTO public.settlements (group_id, from_user, to_user, amount_cents, settled_on, created_by)
  VALUES (tests.g1(), tests.u('b'), tests.u('a'), 1, current_date, tests.u('b'))$$, '42501', 'no direct insert');
SELECT tests.assert_raises($$UPDATE public.settlements SET amount_cents = 1$$, '42501', 'no direct update');
SELECT tests.assert_raises($$DELETE FROM public.settlements$$, '42501', 'no direct delete');
RESET ROLE;
SELECT tests.login(tests.u('d'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq((SELECT count(*) FROM public.settlements), 0::bigint, 'another group''s member reads none');
RESET ROLE;
SET LOCAL ROLE postgres;
SELECT tests.assert_raises($$UPDATE public.settlements SET amount_cents = 1$$, 'P0001', 'amounts are immutable, even for postgres', 'settlements_immutable');
SELECT tests.assert_raises($$DELETE FROM public.settlements$$, 'P0001', 'settlements are never deleted', 'settlements_immutable');
SELECT tests.assert_raises($$DELETE FROM public.group_members WHERE group_id = '10000000-0000-4000-8000-000000000001' AND user_id = '00000000-0000-4000-8000-00000000000b'$$,
  '23503', 'a membership referenced by a settlement cannot be deleted');
SELECT tests.assert_raises($$INSERT INTO public.settlements (group_id, from_user, to_user, amount_cents, settled_on, created_by)
  VALUES (tests.g1(), tests.u('b'), tests.u('c'), 1, current_date, tests.u('b'))$$, '23503', 'parties must have a membership row');
SELECT tests.assert_raises($$INSERT INTO public.settlements (group_id, from_user, to_user, amount_cents, settled_on, created_by, voided_at)
  VALUES (tests.g1(), tests.u('b'), tests.u('a'), 1, current_date, tests.u('b'), now())$$, '23514', 'void columns are all-or-none');
SELECT tests.assert_raises($$INSERT INTO public.settlements (group_id, from_user, to_user, amount_cents, settled_on, created_by)
  VALUES (tests.g1(), tests.u('b'), tests.u('a'), 1, DATE '1999-01-01', tests.u('b'))$$, '23514', 'the date floor is a constraint too');
RESET ROLE;
ROLLBACK;

-- Group deletion is unchanged for solo groups ----------------------------------------
BEGIN;
INSERT INTO public.groups (id, name, created_by) VALUES ('10000000-0000-4000-8000-0000000000f2', 'Solo', tests.u('d'));
SELECT tests.login(tests.u('d'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok($$SELECT public.delete_group('10000000-0000-4000-8000-0000000000f2')$$, 'a solo group can still be deleted');
RESET ROLE;
ROLLBACK;
