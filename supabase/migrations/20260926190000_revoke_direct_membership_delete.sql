SET LOCAL lock_timeout = '5s';

-- M10: remove the last direct membership write path (AR-4, QS-9).
-- Design: docs/phase1/design.md §A2, §B M10 · ADR-0003, ADR-0004.
--
-- Leaving and removal go through leave_group / remove_group_member (M9),
-- which record history instead of deleting rows. The direct DELETE grant,
-- its interim policy and the helper that only that policy used are removed.
--
-- PRODUCTION ORDERING: apply only when every frontend in use calls the M9
-- RPCs (commit 2919523 or later). An older frontend's leave/remove would
-- fail with a permission error after this migration.

REVOKE DELETE ON public.group_members FROM authenticated;
DROP POLICY "Owners can remove members and members can leave" ON public.group_members;
DROP FUNCTION private.my_owned_group_ids();
