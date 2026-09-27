-- Read-only lock pre-flight for a DDL batch on the ledger and membership
-- tables (batch 3 also alters group_members and profiles).
-- Both values must be 0 immediately before `db push`; otherwise wait.
SELECT
  (SELECT count(*) FROM pg_locks l
     JOIN pg_class c ON c.oid = l.relation
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname IN ('expenses', 'expense_splits', 'groups', 'group_members', 'profiles')
      AND l.pid <> pg_backend_pid()) AS other_locks_on_batch_tables,
  (SELECT count(*) FROM pg_stat_activity
    WHERE pid <> pg_backend_pid() AND datname = current_database()
      AND xact_start < now() - interval '5 seconds') AS visible_transactions_older_than_5s;
