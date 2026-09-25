-- M2: remove anonymous access to SECURITY DEFINER functions and harden
-- search_path (QS-2 CRITICAL, QS-8, QS-10).
-- Design: docs/phase1/design.md §A6, §B M2 · ADR-0003.
--
-- Interim state (accepted in design review): `authenticated` keeps EXECUTE on
-- split_chat_is_group_member because current RLS policies call it in the
-- caller's context. It is dropped entirely in M8.

-- Anonymous callers lose the membership oracle and the expense RPC.
REVOKE EXECUTE ON FUNCTION public.split_chat_is_group_member(uuid, uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.create_equal_split_expense(uuid, text, numeric, date, uuid, uuid[], text) FROM PUBLIC, anon;

-- Every reference in these bodies is schema-qualified or in pg_catalog, so
-- an empty search_path changes no behaviour and removes hijack risk.
ALTER FUNCTION public.split_chat_is_group_member(uuid, uuid) SET search_path = '';
ALTER FUNCTION public.create_equal_split_expense(uuid, text, numeric, date, uuid, uuid[], text) SET search_path = '';
ALTER FUNCTION public.set_expenses_updated_at() SET search_path = '';

-- Trigger functions are never called directly; firing a trigger does not
-- check EXECUTE, so clients need no grant.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_expenses_updated_at() FROM PUBLIC, anon, authenticated;
