-- M22: the index set matches the queries the app runs.
SELECT tests.assert(to_regclass('public.expense_splits_expense_id_idx') IS NULL, 'the redundant splits index is gone');
SELECT tests.assert(to_regclass('public.expenses_group_id_idx') IS NULL, 'the single-column group index is gone');
SELECT tests.assert(to_regclass('public.expenses_group_date_idx') IS NOT NULL, 'the group/date index exists');
SELECT tests.assert(EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_splits_unique_participant'),
  'lookups by expense still have the unique (expense_id, user_id) index');

-- The planner can serve the group Expenses query and a split lookup from them.
BEGIN;
SET LOCAL enable_seqscan = off;
SET LOCAL enable_bitmapscan = off; -- with two fixture rows a bitmap scan + sort is cheapest; prove ordered access exists
CREATE TEMP TABLE plan1 (line text);
DO $$
DECLARE r record;
BEGIN
  FOR r IN EXECUTE $q$EXPLAIN SELECT id FROM public.expenses WHERE group_id = '10000000-0000-4000-8000-000000000001'
                       ORDER BY expense_date DESC, created_at DESC$q$ LOOP
    INSERT INTO plan1 VALUES (r."QUERY PLAN");
  END LOOP;
END $$;
SELECT tests.assert(EXISTS (SELECT 1 FROM plan1 WHERE line LIKE '%expenses_group_date_idx%') AND NOT EXISTS (SELECT 1 FROM plan1 WHERE line LIKE '%Sort%'),
  'the group expenses query reads the group/date index in order (no sort): ' || (SELECT string_agg(line, ' | ') FROM plan1));
CREATE TEMP TABLE plan2 (line text);
DO $$
DECLARE r record;
BEGIN
  FOR r IN EXECUTE $q$EXPLAIN SELECT user_id FROM public.expense_splits WHERE expense_id = '20000000-0000-4000-8000-000000000001'$q$ LOOP
    INSERT INTO plan2 VALUES (r."QUERY PLAN");
  END LOOP;
END $$;
SELECT tests.assert(EXISTS (SELECT 1 FROM plan2 WHERE line LIKE '%expense_splits_unique_participant%'),
  'split lookups by expense use the unique index');
ROLLBACK;
