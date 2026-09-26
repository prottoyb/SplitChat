-- Production batch 3 (3a: M11, M12, M13, M15; 3b: M14) read-only pre-checks.
-- Aggregate counts only. Runs inside the asserted read-only transaction
-- (scripts/ops/prod.mjs). Zero-checks per step are listed in prod.mjs.
--
-- Q11/Q12: M11 re-points group_members.user_id and groups.created_by from
--   auth.users to profiles; VALIDATE fails if any row lacks a profile.
-- Q13: M11 drops profiles_id_fkey; today it guarantees every profile has an
--   auth user, so this must be 0.
-- Q16: auth users without a profile. M11's backfill would INSERT them (an
--   additive data write, which would also change the ledger snapshot's
--   profile count); required 0 so batch 3a writes no data.
-- Q4/Q5: ledger balanced (M4 invariants), re-checked before each step.
-- Q14: largest amount (M12 generated cents columns; numeric(12,2) always fits).

SELECT 'Q11 memberships whose user has no profile' AS check, count(*) AS value
  FROM public.group_members gm
 WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = gm.user_id)
UNION ALL
SELECT 'Q12 groups whose creator has no profile', count(*)
  FROM public.groups g
 WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = g.created_by)
UNION ALL
SELECT 'Q13 profiles with no auth user', count(*)
  FROM public.profiles p
 WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)
UNION ALL
SELECT 'Q16 auth users with no profile', count(*)
  FROM auth.users u
 WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id)
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
SELECT 'info: Q14 largest expense amount in cents', coalesce(max(amount * 100), 0)::bigint FROM public.expenses
UNION ALL
SELECT 'info: expenses', count(*) FROM public.expenses
UNION ALL
SELECT 'info: groups', count(*) FROM public.groups
UNION ALL
SELECT 'info: memberships', count(*) FROM public.group_members;
