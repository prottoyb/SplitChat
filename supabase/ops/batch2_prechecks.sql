-- Production batch 2 (M6-M10) read-only pre-checks. Aggregate counts only.
-- Runs inside the asserted read-only transaction (scripts/ops/prod.mjs).
-- Q9 and Q10 are M7 preconditions and must be 0; Q4/Q5 re-check the ledger.

SELECT 'Q9 groups whose owner-row count is not exactly 1' AS check, count(*) AS value
  FROM public.groups g
 WHERE (SELECT count(*) FROM public.group_members gm
         WHERE gm.group_id = g.id AND gm.role = 'owner') <> 1
UNION ALL
SELECT 'Q10 owner rows whose user is not the group creator', count(*)
  FROM public.group_members gm
  JOIN public.groups g ON g.id = gm.group_id
 WHERE gm.role = 'owner' AND gm.user_id <> g.created_by
UNION ALL
SELECT 'Q4 expenses whose splits do not sum to the amount', count(*)
  FROM public.expenses e
 WHERE e.amount <> (SELECT coalesce(sum(s.share_amount), 0)
                      FROM public.expense_splits s WHERE s.expense_id = e.id)
UNION ALL
SELECT 'Q5 expenses with no splits', count(*)
  FROM public.expenses e
 WHERE NOT EXISTS (SELECT 1 FROM public.expense_splits s WHERE s.expense_id = e.id)
UNION ALL
SELECT 'info: memberships', count(*) FROM public.group_members
UNION ALL
SELECT 'info: groups', count(*) FROM public.groups;
