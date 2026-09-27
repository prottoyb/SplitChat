-- Production batch 1 (M0 history adoption + M1-M5) read-only pre-checks.
-- Design: docs/phase1/design.md §B (Q1-Q8), §F (F-R1, F-R2).
--
-- Runs ONLY with a separate execution approval, inside the Phase 0 guard:
--   BEGIN TRANSACTION READ ONLY; assert transaction_read_only = on; ...; ROLLBACK;
-- Aggregate counts only: no row contents, no identifiers, no personal data.
-- Expected: every value 0 except the split_type/total rows (informational).

SELECT 'Q1 splits whose user has no membership row in the expense group' AS check,
       count(*) AS value
  FROM public.expense_splits s
  JOIN public.expenses e ON e.id = s.expense_id
 WHERE NOT EXISTS (SELECT 1 FROM public.group_members gm
                    WHERE gm.group_id = e.group_id AND gm.user_id = s.user_id)
UNION ALL
SELECT 'Q2 expenses whose payer has no membership row in the group', count(*)
  FROM public.expenses e
 WHERE NOT EXISTS (SELECT 1 FROM public.group_members gm
                    WHERE gm.group_id = e.group_id AND gm.user_id = e.paid_by)
UNION ALL
SELECT 'Q3 expenses whose creator has no membership row in the group', count(*)
  FROM public.expenses e
 WHERE NOT EXISTS (SELECT 1 FROM public.group_members gm
                    WHERE gm.group_id = e.group_id AND gm.user_id = e.created_by)
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
SELECT 'Q6 expenses with split_type other than equal', count(*)
  FROM public.expenses WHERE split_type <> 'equal'
UNION ALL
SELECT 'Q7 splits with a non-null percentage', count(*)
  FROM public.expense_splits WHERE percentage IS NOT NULL
UNION ALL
SELECT 'Q8 groups whose creator has no auth user', count(*)
  FROM public.groups g
 WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = g.created_by)
UNION ALL
SELECT 'info: total expenses', count(*) FROM public.expenses
UNION ALL
SELECT 'info: total groups', count(*) FROM public.groups;
