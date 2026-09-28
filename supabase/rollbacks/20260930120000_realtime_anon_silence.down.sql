-- Rollback of M23. No data changes.
DROP POLICY "Anonymous callers see no proposals" ON public.expense_candidates;
DROP POLICY "Anonymous callers see no messages" ON public.group_messages;
REVOKE SELECT ON public.group_messages, public.expense_candidates FROM anon;
