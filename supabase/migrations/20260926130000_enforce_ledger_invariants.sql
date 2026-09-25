-- M4: the database enforces the ledger's financial invariants for every
-- role (QS-3 HIGH, AR-2, AR-10). Design: docs/phase1/design.md §A3 ·
-- ADR-0002.
--
--  1. Balance: at commit, every existing expense has at least one split and
--     its splits sum exactly to its amount (deferred constraint triggers, so
--     multi-statement writes inside one transaction are fine).
--  2. Membership: a payer and every split user must have a membership row
--     in the expense's group when the row is written. (Rows already in the
--     table are not re-validated; historical data stays as it is.)
--  3. Only equal splits exist today; split_type is narrowed to 'equal'.
--
-- Production pre-checks (design §B, Q4-Q7) must return 0 before applying.
--
-- The check functions are SECURITY DEFINER (owner postgres, BYPASSRLS,
-- search_path ''): deferred triggers fire at COMMIT as the session's role
-- (e.g. authenticated after an RPC), and an invariant must see every row,
-- never an RLS-filtered subset. No role is granted EXECUTE on them.

CREATE FUNCTION private.assert_expense_balanced(p_expense_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_amount numeric;
  v_split_count bigint;
  v_split_total numeric;
BEGIN
  SELECT e.amount INTO v_amount FROM public.expenses e WHERE e.id = p_expense_id;
  IF NOT FOUND THEN
    RETURN;  -- deleted in this transaction; its splits cascade with it
  END IF;

  SELECT count(*), coalesce(sum(s.share_amount), 0)
    INTO v_split_count, v_split_total
    FROM public.expense_splits s
   WHERE s.expense_id = p_expense_id;

  IF v_split_count = 0 OR v_split_total <> v_amount THEN
    RAISE EXCEPTION 'expense_unbalanced'
      USING ERRCODE = 'P0001',
            DETAIL = format('Expense %s: amount %s, %s split(s) totalling %s.',
                            p_expense_id, v_amount, v_split_count, v_split_total);
  END IF;
END
$$;
REVOKE ALL ON FUNCTION private.assert_expense_balanced(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.check_expense_balanced() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_TABLE_NAME = 'expenses' THEN
    PERFORM private.assert_expense_balanced(NEW.id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM private.assert_expense_balanced(OLD.expense_id);
  ELSE
    PERFORM private.assert_expense_balanced(NEW.expense_id);
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION private.check_expense_balanced() FROM PUBLIC, anon, authenticated, service_role;

CREATE CONSTRAINT TRIGGER expense_splits_balanced
  AFTER INSERT OR UPDATE OR DELETE ON public.expense_splits
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.check_expense_balanced();

CREATE CONSTRAINT TRIGGER expenses_balanced
  AFTER INSERT OR UPDATE OF amount ON public.expenses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION private.check_expense_balanced();

CREATE FUNCTION private.guard_ledger_membership() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_group_id uuid;
  v_user_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'expenses' THEN
    IF TG_OP = 'UPDATE' AND NEW.paid_by IS NOT DISTINCT FROM OLD.paid_by THEN
      RETURN NEW;
    END IF;
    v_group_id := NEW.group_id;
    v_user_id := NEW.paid_by;
  ELSE
    SELECT e.group_id INTO v_group_id FROM public.expenses e WHERE e.id = NEW.expense_id;
    v_user_id := NEW.user_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.group_members gm
     WHERE gm.group_id = v_group_id AND gm.user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'ledger_member_required'
      USING ERRCODE = 'P0001',
            DETAIL = 'Payers and split participants must be members of the expense''s group.';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION private.guard_ledger_membership() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER expenses_guard_membership
  BEFORE INSERT OR UPDATE OF paid_by ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION private.guard_ledger_membership();

-- expense_splits.user_id and expense_id are immutable (M1), so INSERT is
-- the only write that can introduce a participant.
CREATE TRIGGER expense_splits_guard_membership
  BEFORE INSERT ON public.expense_splits
  FOR EACH ROW EXECUTE FUNCTION private.guard_ledger_membership();

ALTER TABLE public.expenses DROP CONSTRAINT expenses_split_type_check;
ALTER TABLE public.expenses
  ADD CONSTRAINT expenses_split_type_check CHECK (split_type = 'equal') NOT VALID;
ALTER TABLE public.expenses VALIDATE CONSTRAINT expenses_split_type_check;
