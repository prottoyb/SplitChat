-- Rollback of M13: removes expense edit/delete. Edits and deletions already
-- made are not undone (they are ordinary ledger changes). The updated_by
-- audit column is dropped only while it holds no data; otherwise it is kept
-- (nullable, unused) so no audit information is silently discarded.
DROP FUNCTION public.delete_expense(uuid, timestamptz);
DROP FUNCTION public.update_equal_split_expense(uuid, timestamptz, text, bigint, date, uuid, uuid[], text);
DROP FUNCTION private.lock_expense_for_management(uuid, timestamptz);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.expenses WHERE updated_by IS NOT NULL) THEN
    RAISE NOTICE 'M13 rollback: expenses.updated_by holds audit data and is kept';
  ELSE
    ALTER TABLE public.expenses DROP COLUMN updated_by;
  END IF;
END
$$;
