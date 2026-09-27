-- Rollback of M3. Recovery only: re-opens direct ledger writes (QS-3). In
-- production, apply as a new forward migration under its own approval.
-- Policy text is verbatim from supabase/baseline/public_schema.sql.
CREATE POLICY "Expense creators can create expense splits" ON public.expense_splits FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.expenses e
  WHERE ((e.id = expense_splits.expense_id) AND (e.created_by = auth.uid()) AND public.split_chat_is_group_member(e.group_id, expense_splits.user_id)))));
CREATE POLICY "Expense creators can delete expense splits" ON public.expense_splits FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.expenses e
  WHERE ((e.id = expense_splits.expense_id) AND (e.created_by = auth.uid())))));
CREATE POLICY "Expense creators can delete expenses" ON public.expenses FOR DELETE TO authenticated USING (((created_by = auth.uid()) AND public.split_chat_is_group_member(group_id, auth.uid())));
CREATE POLICY "Expense creators can update expense splits" ON public.expense_splits FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.expenses e
  WHERE ((e.id = expense_splits.expense_id) AND (e.created_by = auth.uid()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.expenses e
  WHERE ((e.id = expense_splits.expense_id) AND (e.created_by = auth.uid()) AND public.split_chat_is_group_member(e.group_id, expense_splits.user_id)))));
CREATE POLICY "Expense creators can update expenses" ON public.expenses FOR UPDATE TO authenticated USING (((created_by = auth.uid()) AND public.split_chat_is_group_member(group_id, auth.uid()))) WITH CHECK (((created_by = auth.uid()) AND public.split_chat_is_group_member(group_id, auth.uid()) AND public.split_chat_is_group_member(group_id, paid_by)));
CREATE POLICY "Group members can create expenses" ON public.expenses FOR INSERT TO authenticated WITH CHECK (((created_by = auth.uid()) AND public.split_chat_is_group_member(group_id, auth.uid()) AND public.split_chat_is_group_member(group_id, paid_by)));

GRANT SELECT ON public.expenses, public.expense_splits TO anon;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.expenses, public.expense_splits TO anon, authenticated;
