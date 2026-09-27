-- M15: delete_group (approved rule 2026-09-26; design §A2, §A7 (8), L6, S9).
-- A group may be deleted only by its active owner, only if nobody else has
-- ever been a member, and only if no record refers to anyone else.
-- Fixture: G1 owner A (members B, E); G2 owner D (members C, A).

CREATE FUNCTION tests.u(letter text) RETURNS uuid LANGUAGE sql IMMUTABLE
  AS $f$ SELECT ('00000000-0000-4000-8000-00000000000' || letter)::uuid $f$;
CREATE FUNCTION tests.g(n int) RETURNS uuid LANGUAGE sql IMMUTABLE
  AS $f$ SELECT ('10000000-0000-4000-8000-0000000000a' || n)::uuid $f$;
-- A fresh group owned by `owner` (the on_group_created trigger adds the owner row).
CREATE FUNCTION tests.solo_group(n int, owner uuid) RETURNS uuid LANGUAGE sql
  AS $f$ INSERT INTO public.groups (id, name, created_by) VALUES (tests.g(n), 'Solo ' || n, owner) RETURNING id $f$;
-- A balanced expense in `grp`, split equally by the superuser (bypasses RPC rules).
CREATE FUNCTION tests.expense(grp uuid, paid_by uuid, created_by uuid, participants uuid[], cents bigint)
RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.expenses (group_id, description, amount, paid_by, created_by)
  VALUES (grp, 'Test', cents::numeric / 100, paid_by, created_by) RETURNING id INTO v_id;
  INSERT INTO public.expense_splits (expense_id, user_id, share_amount)
  SELECT v_id, s.user_id, s.share_cents::numeric / 100 FROM private.equal_split_cents(cents, participants) s;
  RETURN v_id;
END $f$;

-- Surface --------------------------------------------------------------------
SELECT tests.assert(has_function_privilege('authenticated', 'public.delete_group(uuid)', 'EXECUTE'), 'authenticated can execute delete_group');
SELECT tests.assert(NOT has_function_privilege('anon', 'public.delete_group(uuid)', 'EXECUTE'), 'anon cannot execute delete_group');
SELECT tests.assert(NOT has_function_privilege('service_role', 'public.delete_group(uuid)', 'EXECUTE'), 'service_role has no delete_group grant');
SELECT tests.assert(NOT has_table_privilege('authenticated', 'public.groups', 'DELETE'), 'direct group DELETE is still revoked');

-- Allowed: a genuinely solo group, empty or with the owner's own ledger ---------
BEGIN;
SELECT tests.solo_group(1, tests.u('a'));
SELECT tests.solo_group(2, tests.u('a'));
SELECT tests.expense(tests.g(2), tests.u('a'), tests.u('a'), ARRAY[tests.u('a')], 1234);
SELECT tests.expense(tests.g(2), tests.u('a'), tests.u('a'), ARRAY[tests.u('a')], 1);
INSERT INTO private.member_add_attempts (caller_id, group_id)
SELECT tests.u('a'), tests.g(2) FROM generate_series(1, 5);
CREATE TEMP TABLE before_totals AS
SELECT (SELECT count(*) FROM public.expenses WHERE group_id NOT IN (tests.g(1), tests.g(2))) AS other_expenses,
       (SELECT sum(amount) FROM public.expenses WHERE group_id NOT IN (tests.g(1), tests.g(2))) AS other_total,
       (SELECT count(*) FROM public.group_members WHERE group_id NOT IN (tests.g(1), tests.g(2))) AS other_memberships;
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_ok($$SELECT public.delete_group(tests.g(1))$$, 'owner deletes an empty solo group');
SELECT tests.assert_ok($$SELECT public.delete_group(tests.g(2))$$, 'owner deletes a solo group with their own private ledger');
SELECT tests.assert_raises($$SELECT public.delete_group(tests.g(2))$$,
  'P0001', 'deleting it again -> not_found_or_forbidden', 'not_found_or_forbidden');
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
SELECT tests.assert_eq((SELECT count(*) FROM public.groups WHERE id IN (tests.g(1), tests.g(2))), 0::bigint, 'both groups are gone');
SELECT tests.assert_eq((SELECT count(*) FROM public.group_members WHERE group_id IN (tests.g(1), tests.g(2))), 0::bigint, 'their memberships are gone');
SELECT tests.assert_eq((SELECT count(*) FROM public.expenses WHERE group_id = tests.g(2)), 0::bigint, 'the solo ledger is gone');
SELECT tests.assert_eq(
  (SELECT count(*) FROM public.expense_splits s WHERE NOT EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = s.expense_id)),
  0::bigint, 'no orphaned splits');
SELECT tests.assert_eq(
  (SELECT row(count(*), sum(amount))::text FROM public.expenses),
  (SELECT row(other_expenses, other_total)::text FROM before_totals), 'every other group''s ledger is untouched');
SELECT tests.assert_eq((SELECT count(*) FROM public.group_members), (SELECT other_memberships FROM before_totals),
  'every other membership is untouched');
SELECT tests.assert_eq((SELECT count(*) FROM private.member_add_attempts WHERE caller_id = tests.u('a')), 5::bigint,
  'add-by-email rate-limit history survives group deletion (no create-probe-delete reset)');
ROLLBACK;

-- Authorization first (DS-1, S9) ----------------------------------------------
BEGIN;
SELECT tests.solo_group(3, tests.u('c'));
SELECT tests.logout();
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.delete_group(tests.g(3))$$, 'P0001', 'no session -> auth_required', 'auth_required');
RESET ROLE;
SELECT tests.login(tests.u('b'));  -- Bob: member of G1, not owner
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.delete_group('10000000-0000-4000-8000-000000000001')$$,
  'P0001', 'member (not owner) -> not_found_or_forbidden', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.delete_group(tests.g(3))$$,
  'P0001', 'outsider, existing solo group of someone else -> not_found_or_forbidden', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.delete_group('10000000-0000-4000-8000-0000000000ff')$$,
  'P0001', 'outsider, nonexistent group -> identical not_found_or_forbidden (S9)', 'not_found_or_forbidden');
SELECT tests.assert_raises($$SELECT public.delete_group(NULL)$$,
  'P0001', 'null group -> not_found_or_forbidden', 'not_found_or_forbidden');
RESET ROLE;
SELECT tests.assert_eq((SELECT count(*) FROM public.groups WHERE id = tests.g(3)), 1::bigint, 'refused deletions change nothing');
ROLLBACK;

-- Refused: anyone else has ever been a member ----------------------------------
BEGIN;
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.delete_group('10000000-0000-4000-8000-000000000001')$$,
  'P0001', 'owner of a group with active members -> group_has_other_members', 'group_has_other_members');
RESET ROLE;
ROLLBACK;

-- Every kind of former member counts: left, removed, account deleted. Each
-- group's only ACTIVE member is the owner, so an active-count rule would
-- wrongly allow these.
BEGIN;
SELECT tests.solo_group(4, tests.u('a'));
SELECT tests.solo_group(5, tests.u('a'));
SELECT tests.solo_group(6, tests.u('a'));
INSERT INTO public.group_members (group_id, user_id, role, left_at, left_reason, removed_by) VALUES
  (tests.g(4), tests.u('b'), 'member', now(), 'left', NULL),
  (tests.g(5), tests.u('b'), 'member', now(), 'removed', tests.u('a')),
  (tests.g(6), tests.u('b'), 'member', now(), 'account_deleted', NULL);
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.delete_group(tests.g(4))$$,
  'P0001', 'a member who left still counts -> group_has_other_members', 'group_has_other_members');
SELECT tests.assert_raises($$SELECT public.delete_group(tests.g(5))$$,
  'P0001', 'a removed member still counts -> group_has_other_members', 'group_has_other_members');
SELECT tests.assert_raises($$SELECT public.delete_group(tests.g(6))$$,
  'P0001', 'a member whose account was deleted still counts -> group_has_other_members', 'group_has_other_members');
RESET ROLE;
SELECT tests.assert_eq((SELECT count(*) FROM public.groups WHERE id IN (tests.g(4), tests.g(5), tests.g(6))), 3::bigint,
  'groups with historical members survive');
ROLLBACK;

-- The history check is independent: a membership hard-deleted before M7/M10
-- left no row, but the ledger still refers to that person. Each variant is
-- a solo group (only the owner's membership row) with one foreign reference.
BEGIN;
SELECT tests.solo_group(n, tests.u('a')) FROM generate_series(1, 5) AS n;
-- g6: created by Bob (created_by is immutable), now owned by Alice; Bob's
-- owner row was hard-deleted long ago.
SELECT tests.solo_group(6, tests.u('b'));
DELETE FROM public.group_members WHERE group_id = tests.g(6);
INSERT INTO public.group_members (group_id, user_id, role) VALUES (tests.g(6), tests.u('a'), 'owner');
INSERT INTO public.group_members (group_id, user_id, role)
SELECT tests.g(n), tests.u('b'), 'member' FROM generate_series(1, 4) AS n;  -- Bob, briefly, for the ledger guard
SELECT tests.expense(tests.g(1), tests.u('a'), tests.u('a'), ARRAY[tests.u('a'), tests.u('b')], 1000);  -- split for Bob
SELECT tests.expense(tests.g(2), tests.u('b'), tests.u('a'), ARRAY[tests.u('a')], 1000);                -- paid by Bob
SELECT tests.expense(tests.g(3), tests.u('a'), tests.u('b'), ARRAY[tests.u('a')], 1000);                -- created by Bob
SELECT tests.expense(tests.g(4), tests.u('a'), tests.u('a'), ARRAY[tests.u('a')], 1000);
UPDATE public.expenses SET updated_by = tests.u('b') WHERE group_id = tests.g(4);                       -- last edited by Bob
DELETE FROM public.group_members WHERE user_id = tests.u('b') AND group_id IN (tests.g(1), tests.g(2), tests.g(3), tests.g(4));
UPDATE public.group_members SET removed_by = tests.u('b') WHERE group_id = tests.g(5);                   -- audit ref to Bob
SET CONSTRAINTS ALL IMMEDIATE;
SELECT tests.assert_eq(
  (SELECT count(*) FROM public.group_members WHERE group_id IN (SELECT tests.g(n) FROM generate_series(1, 6) AS n) AND user_id <> tests.u('a')),
  0::bigint, 'setup: the owner is the only membership row in every variant');
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.delete_group(tests.g(1))$$,
  'P0001', 'a split for another user -> group_has_shared_history', 'group_has_shared_history');
SELECT tests.assert_raises($$SELECT public.delete_group(tests.g(2))$$,
  'P0001', 'an expense paid by another user -> group_has_shared_history', 'group_has_shared_history');
SELECT tests.assert_raises($$SELECT public.delete_group(tests.g(3))$$,
  'P0001', 'an expense created by another user -> group_has_shared_history', 'group_has_shared_history');
SELECT tests.assert_raises($$SELECT public.delete_group(tests.g(4))$$,
  'P0001', 'an expense last edited by another user -> group_has_shared_history', 'group_has_shared_history');
SELECT tests.assert_raises($$SELECT public.delete_group(tests.g(5))$$,
  'P0001', 'a membership record naming another user -> group_has_shared_history', 'group_has_shared_history');
SELECT tests.assert_raises($$SELECT public.delete_group(tests.g(6))$$,
  'P0001', 'a group created by another user -> group_has_shared_history', 'group_has_shared_history');
RESET ROLE;
SELECT tests.assert_eq((SELECT count(*) FROM public.expenses WHERE group_id IN (SELECT tests.g(n) FROM generate_series(1, 6) AS n)),
  4::bigint, 'shared financial history is never destroyed');
ROLLBACK;

-- Former owner / orphaned group (DS-3): a sole owner who deleted their account
-- no longer owns anything; nobody can delete the retained group.
BEGIN;
SELECT tests.solo_group(7, tests.u('c'));
SELECT tests.expense(tests.g(7), tests.u('c'), tests.u('c'), ARRAY[tests.u('c')], 500);
UPDATE public.group_members SET role = 'member', left_at = now(), left_reason = 'account_deleted'
 WHERE group_id = tests.g(7);
SELECT tests.login(tests.u('c'));
SET LOCAL ROLE authenticated;
SELECT tests.assert_raises($$SELECT public.delete_group(tests.g(7))$$,
  'P0001', 'orphaned group: former sole owner -> not_found_or_forbidden', 'not_found_or_forbidden');
RESET ROLE;
ROLLBACK;

-- Ownership moved away before the call: the previous owner can no longer delete.
BEGIN;
SELECT tests.login(tests.u('a'));
SET LOCAL ROLE authenticated;
SELECT public.transfer_group_ownership('10000000-0000-4000-8000-000000000001', tests.u('b'));
SELECT tests.assert_raises($$SELECT public.delete_group('10000000-0000-4000-8000-000000000001')$$,
  'P0001', 'former owner after transfer -> not_found_or_forbidden', 'not_found_or_forbidden');
RESET ROLE;
ROLLBACK;
