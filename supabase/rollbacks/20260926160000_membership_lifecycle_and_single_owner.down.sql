-- Rollback of M7. Recovery only, and only while no membership has been
-- marked as left: dropping the columns discards membership history. In
-- production, apply as a new forward migration under its own approval.
DROP TRIGGER groups_guard_immutables ON public.groups;
DROP FUNCTION private.guard_group_immutables();
DROP INDEX public.group_members_one_active_owner;
ALTER TABLE public.group_members
  DROP CONSTRAINT group_members_owner_active,
  DROP CONSTRAINT group_members_removed_by_consistency,
  DROP CONSTRAINT group_members_left_consistency,
  DROP CONSTRAINT group_members_left_reason_check,
  DROP COLUMN removed_by,
  DROP COLUMN left_reason,
  DROP COLUMN left_at;
