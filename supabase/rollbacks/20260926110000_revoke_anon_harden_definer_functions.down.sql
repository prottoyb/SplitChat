-- Rollback of M2. Recovery only: re-opens the anonymous membership oracle
-- (QS-2). In production, apply as a new forward migration under its own
-- approval.
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_expenses_updated_at() TO PUBLIC, anon, authenticated;

ALTER FUNCTION public.split_chat_is_group_member(uuid, uuid) SET search_path = public;
ALTER FUNCTION public.create_equal_split_expense(uuid, text, numeric, date, uuid, uuid[], text) SET search_path = public, pg_temp;
ALTER FUNCTION public.set_expenses_updated_at() SET search_path = public;

GRANT EXECUTE ON FUNCTION public.split_chat_is_group_member(uuid, uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.create_equal_split_expense(uuid, text, numeric, date, uuid, uuid[], text) TO anon;
