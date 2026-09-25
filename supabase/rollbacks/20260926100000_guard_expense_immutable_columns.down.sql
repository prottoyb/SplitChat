-- Rollback of M1. Recovery only: re-opens QS-1 (cross-group expense move).
-- In production, apply as a new forward migration under its own approval.
DROP TRIGGER expense_splits_guard_immutables ON public.expense_splits;
DROP TRIGGER expenses_guard_immutables ON public.expenses;
DROP FUNCTION private.guard_split_immutables();
DROP FUNCTION private.guard_expense_immutables();
DROP SCHEMA private;
