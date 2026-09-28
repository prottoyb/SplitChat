SET LOCAL lock_timeout = '5s';

-- M22: index cleanup (the Phase 1 deferred "M16 index cleanup", re-evaluated
-- in Phase 8 against the queries the app actually runs).
--
--  - DROP expense_splits_expense_id_idx: fully redundant with the unique
--    constraint expense_splits_unique_participant (expense_id, user_id),
--    whose leading column serves every lookup by expense_id.
--  - CREATE expenses_group_date_idx (group_id, expense_date DESC,
--    created_at DESC): the group Expenses/Overview query filters by group
--    and orders by date then creation time (Phase 5); it also serves every
--    lookup by group_id (delete_group, the foreign key), so the single-column
--    expenses_group_id_idx is dropped as redundant.
--  - NOT done: a partial group_members (user_id) WHERE left_at IS NULL index.
--    Every RLS check filters memberships by user_id, but the existing
--    group_members_user_id_idx is already highly selective (few memberships
--    per person); the partial index would add write cost for no measurable
--    gain. Revisit with production statistics.
--
-- Plain (not CONCURRENTLY) index DDL: migrations run in a transaction, and
-- the tables are small; lock_timeout bounds any wait. Postchecks confirm the
-- final index set.
--
-- Rollback: recreate the two dropped indexes and drop the new one (safe at
-- any time; no data changes).

DROP INDEX public.expense_splits_expense_id_idx;
CREATE INDEX expenses_group_date_idx ON public.expenses (group_id, expense_date DESC, created_at DESC);
DROP INDEX public.expenses_group_id_idx;
