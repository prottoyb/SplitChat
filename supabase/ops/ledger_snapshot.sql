-- Read-only ledger integrity snapshot (aggregates only, no row contents).
-- Taken before and after a migration batch; the two outputs must be equal.
SELECT count(*) AS expenses,
       sum(amount) AS total_amount,
       (SELECT count(*) FROM public.expense_splits) AS splits,
       (SELECT sum(share_amount) FROM public.expense_splits) AS total_shares,
       (SELECT count(*) FROM public.groups) AS groups,
       (SELECT count(*) FROM public.group_members) AS memberships,
       (SELECT count(*) FROM public.profiles) AS profiles,
       md5(string_agg(id::text || ':' || amount::text, ',' ORDER BY id)) AS expense_digest,
       (SELECT md5(string_agg(expense_id::text || ':' || user_id::text || ':' || share_amount::text, ','
                              ORDER BY expense_id, user_id)) FROM public.expense_splits) AS split_digest
  FROM public.expenses;
