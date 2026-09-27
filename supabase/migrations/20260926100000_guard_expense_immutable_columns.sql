-- M1: an expense can never move between groups (QS-1, CRITICAL).
-- Design: docs/phase1/design.md §A3.1, §B M1 · ADR-0002.
--
-- BEFORE UPDATE guards make the identity columns of expenses and splits
-- immutable for every role, including service_role and dashboard SQL:
--   expenses:       id, group_id, created_by, created_at
--   expense_splits: id, expense_id, user_id
-- Also creates the non-exposed `private` schema for internal functions
-- (ADR-0003). Nothing here is granted to client roles; trigger functions do
-- not need EXECUTE to fire.

CREATE SCHEMA private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;

CREATE FUNCTION private.guard_expense_immutables() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'immutable_field'
      USING ERRCODE = 'P0001',
            DETAIL = 'expenses.id, group_id, created_by and created_at cannot be changed.';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION private.guard_expense_immutables() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.guard_split_immutables() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.expense_id IS DISTINCT FROM OLD.expense_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'immutable_field'
      USING ERRCODE = 'P0001',
            DETAIL = 'expense_splits.id, expense_id and user_id cannot be changed.';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION private.guard_split_immutables() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER expenses_guard_immutables
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION private.guard_expense_immutables();

CREATE TRIGGER expense_splits_guard_immutables
  BEFORE UPDATE ON public.expense_splits
  FOR EACH ROW EXECUTE FUNCTION private.guard_split_immutables();
