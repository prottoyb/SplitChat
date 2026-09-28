-- Production batch 4 (M16-M23) read-only pre-checks. Aggregate counts only.
-- Runs inside the asserted read-only transaction (scripts/ops/prod.mjs).
-- Zero-checks: Q4, Q5, Q20, Q21, Q22 (listed in prod.mjs).
--
-- Q4/Q5: ledger balanced (M4 invariants) before any change.
-- Q20: the Supabase Realtime publication must exist (M18 and M19 add
--   group_messages and expense_candidates to it; the migrations fail
--   otherwise, and the app's live updates depend on it).
-- Q21: it must not be FOR ALL TABLES (that would publish every table,
--   including the ledger, and ADD TABLE would fail).
-- Q22: it must hold no table yet: batch 4 expects to add exactly two, and
--   any other published table would be exposed to Realtime subscribers.
--   If this is not 0, stop and assess (someone enabled Realtime on a table
--   in the dashboard).
-- info: rows the M16 backfill will create, for the evidence package: one
--   event per group, per non-founding membership, per ended membership and
--   per expense (their sum is the group_events count right after the push).

SELECT 'Q4 expenses whose splits do not sum to the amount' AS check, count(*) AS value
  FROM public.expenses e
 WHERE e.amount <> (SELECT coalesce(sum(s.share_amount), 0)
                      FROM public.expense_splits s WHERE s.expense_id = e.id)
UNION ALL
SELECT 'Q5 expenses with no splits', count(*)
  FROM public.expenses e
 WHERE NOT EXISTS (SELECT 1 FROM public.expense_splits s WHERE s.expense_id = e.id)
UNION ALL
SELECT 'Q20 supabase_realtime publication missing', count(*)
  FROM (SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')) x
UNION ALL
SELECT 'Q21 supabase_realtime is FOR ALL TABLES', count(*)
  FROM pg_publication WHERE pubname = 'supabase_realtime' AND puballtables
UNION ALL
SELECT 'Q22 tables already in supabase_realtime', count(*)
  FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
UNION ALL
SELECT 'info: groups (M16 backfills one group_created event each)', count(*) FROM public.groups
UNION ALL
SELECT 'info: memberships other than the founder (M16 backfills member_added)', count(*)
  FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id
 WHERE gm.user_id <> g.created_by
UNION ALL
SELECT 'info: ended memberships (M16 backfills member_left/removed/account_deleted)', count(*)
  FROM public.group_members WHERE left_at IS NOT NULL
UNION ALL
SELECT 'info: expenses (M16 backfills expense_created)', count(*) FROM public.expenses;
