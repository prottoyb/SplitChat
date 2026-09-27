-- Tenant isolation that already works and must be preserved.
BEGIN;
SELECT tests.login('00000000-0000-4000-8000-00000000000c');  -- Cara: G2 only
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq((SELECT count(*) FROM public.groups WHERE id = '10000000-0000-4000-8000-000000000001'), 0::bigint,
  'outsider cannot see G1');
SELECT tests.assert_eq((SELECT count(*) FROM public.expenses WHERE group_id = '10000000-0000-4000-8000-000000000001'), 0::bigint,
  'outsider cannot see G1 expenses');
SELECT tests.assert_eq((SELECT count(*) FROM public.expense_splits
                         WHERE expense_id IN ('20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002')),
  0::bigint, 'outsider cannot see G1 splits');
SELECT tests.assert_eq((SELECT count(*) FROM public.group_members WHERE group_id = '10000000-0000-4000-8000-000000000001'), 0::bigint,
  'outsider cannot see G1 members');
SELECT tests.assert_eq((SELECT count(*) FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000000000b'), 0::bigint,
  'outsider cannot see an unrelated profile');
SELECT tests.assert_eq((SELECT count(*) FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000000000a'), 1::bigint,
  'co-member profile is visible');
RESET ROLE;

SELECT tests.login('00000000-0000-4000-8000-00000000000b');  -- Bob: G1 member
SET LOCAL ROLE authenticated;
SELECT tests.assert_eq((SELECT count(*) FROM public.expenses), 2::bigint, 'member sees exactly the expenses of their group');
SELECT tests.assert_eq((SELECT count(*) FROM public.group_members), 3::bigint, 'member sees the members of their group');
ROLLBACK;
