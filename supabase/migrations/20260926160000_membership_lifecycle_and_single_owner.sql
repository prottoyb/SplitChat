SET LOCAL lock_timeout = '5s';

-- M7: soft membership history and a single active owner per group
-- (AR-3, AR-5). Design: docs/phase1/design.md §A4, §A5, §B M7 · ADR-0004.
--
--  - Leaving or being removed will mark the row (left_at, left_reason,
--    removed_by) instead of deleting it, so historical ledger rows keep a
--    valid membership record. The RPCs arrive in M9; RLS in M8 shows only
--    active rows.
--  - group_members.role is the source of truth for ownership: at most one
--    active owner per group, and an owner row can never be marked as left.
--  - groups.id, created_by and created_at are immutable. created_by is now
--    the creator (audit), not the owner.
--
-- Production pre-checks: Q9 groups whose owner-row count <> 1 = 0;
-- Q10 owner rows whose user_id <> groups.created_by = 0.

ALTER TABLE public.group_members
  ADD COLUMN left_at timestamptz,
  ADD COLUMN left_reason text,
  ADD COLUMN removed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.group_members
  ADD CONSTRAINT group_members_left_reason_check
    CHECK (left_reason IN ('left', 'removed', 'account_deleted')),
  ADD CONSTRAINT group_members_left_consistency
    CHECK ((left_at IS NULL) = (left_reason IS NULL)),
  ADD CONSTRAINT group_members_removed_by_consistency
    CHECK (removed_by IS NULL OR left_reason = 'removed'),
  ADD CONSTRAINT group_members_owner_active
    CHECK (role <> 'owner' OR left_at IS NULL);

CREATE UNIQUE INDEX group_members_one_active_owner
  ON public.group_members (group_id)
  WHERE role = 'owner' AND left_at IS NULL;

CREATE FUNCTION private.guard_group_immutables() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'immutable_field'
      USING ERRCODE = 'P0001',
            DETAIL = 'groups.id, created_by and created_at cannot be changed.';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION private.guard_group_immutables() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER groups_guard_immutables
  BEFORE UPDATE ON public.groups
  FOR EACH ROW EXECUTE FUNCTION private.guard_group_immutables();
