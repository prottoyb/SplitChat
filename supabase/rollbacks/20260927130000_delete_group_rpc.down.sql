-- Rollback of M15: removes group deletion. Groups already deleted are not
-- restored (each deletion was a user action on a solo group).
DROP FUNCTION public.delete_group(uuid);
