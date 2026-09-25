-- M3: clients can no longer write the ledger tables directly (QS-3 HIGH;
-- defence in depth for QS-1). Design: docs/phase1/design.md §A3, §B M3 ·
-- ADR-0002.
--
-- The frontend never writes expenses/expense_splits directly; it uses the
-- SECURITY DEFINER RPC create_equal_split_expense, which is unaffected.
-- Edit/delete arrive as RPCs in M13. Reads (SELECT policies) are unchanged.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.expenses, public.expense_splits FROM anon, authenticated;
REVOKE SELECT ON public.expenses, public.expense_splits FROM anon;

DROP POLICY "Expense creators can create expense splits" ON public.expense_splits;
DROP POLICY "Expense creators can update expense splits" ON public.expense_splits;
DROP POLICY "Expense creators can delete expense splits" ON public.expense_splits;
DROP POLICY "Group members can create expenses" ON public.expenses;
DROP POLICY "Expense creators can update expenses" ON public.expenses;
DROP POLICY "Expense creators can delete expenses" ON public.expenses;
