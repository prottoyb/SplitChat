-- Rollback of M22: restores the baseline indexes. No data changes.

CREATE INDEX expenses_group_id_idx ON public.expenses USING btree (group_id);
DROP INDEX public.expenses_group_date_idx;
CREATE INDEX expense_splits_expense_id_idx ON public.expense_splits USING btree (expense_id);
