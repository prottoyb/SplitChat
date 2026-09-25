-- Rollback of M4. Recovery only: removes the database's financial
-- invariants. In production, apply as a new forward migration under its own
-- approval.
ALTER TABLE public.expenses DROP CONSTRAINT expenses_split_type_check;
ALTER TABLE public.expenses
  ADD CONSTRAINT expenses_split_type_check CHECK ((split_type = ANY (ARRAY['equal'::text, 'exact'::text, 'percentage'::text])));

DROP TRIGGER expense_splits_guard_membership ON public.expense_splits;
DROP TRIGGER expenses_guard_membership ON public.expenses;
DROP FUNCTION private.guard_ledger_membership();

DROP TRIGGER expenses_balanced ON public.expenses;
DROP TRIGGER expense_splits_balanced ON public.expense_splits;
DROP FUNCTION private.check_expense_balanced();
DROP FUNCTION private.assert_expense_balanced(uuid);
