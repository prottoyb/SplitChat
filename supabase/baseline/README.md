# Supabase schema baseline (Phase 0)

Read-only snapshot of the live SplitChat Supabase database, captured
2026-09-26. It records what production actually contains **before** the
schema is brought under source control. It is documentation and the input
to Phase 1 — it is **not** a migration.

> Do not apply or restore these files. `public_schema.sql` recreates the
> schema from scratch and would fail or clobber objects on an existing
> database. Phase 1 decides how (and whether) to turn it into the first file
> in `supabase/migrations/`.

## Files

| File | What it is |
|---|---|
| `public_schema.sql` | `pg_dump --schema-only --schema=public` (pg_dump 17.11, server 17.6). Tables, constraints, indexes, functions, triggers, RLS policies, grants and default privileges of the `public` schema. No table data. |
| `catalog_overview.sql` / `.txt` | First guarded query run: read-only assertion, server version, schemas (owner, table/function counts) and installed extensions. |
| `catalog_inventory.sql` | Catalog/metadata queries used for the inventory (SELECT-only). |
| `catalog_inventory.txt` | Output of those queries. No table rows are read; `est_rows` is planner metadata (`-1` = never analysed). |

## What is *not* in `public_schema.sql`

`pg_dump --schema=public` omits objects in Supabase-managed schemas even when
they belong to the app. Captured in the inventory instead:

- Trigger `on_auth_user_created` — `AFTER INSERT ON auth.users FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user()` (creates the profile row).
- Storage and Realtime: no app policies on `storage.*`; publication
  `supabase_realtime` exists with **no** tables.
- Extensions: `pgcrypto`, `uuid-ossp`, `pg_stat_statements` (schema
  `extensions`), `supabase_vault`, `plpgsql`.

Supabase-managed schemas (`auth`, `storage`, `realtime`, `vault`, `graphql*`,
`extensions`) are owned by the platform and deliberately not captured.

## Migration history

There is **no** `supabase_migrations` schema: the live database has never
been managed by the Supabase CLI, and no migration history exists anywhere.
Every object in `public` was created by hand (SQL editor / dashboard).

## How it was captured

- Connection: Supabase **session pooler** (the direct IPv6-only endpoint was
  unreachable from the capture machine). The pooler drops `PGOPTIONS`, so
  read-only was enforced per transaction instead:
  every `psql` run executed `BEGIN TRANSACTION READ ONLY;`, asserted
  `transaction_read_only = on` in the same transaction (aborting otherwise),
  ran SELECT-only catalog queries, and ended with `ROLLBACK;`.
  `pg_dump` runs its own `REPEATABLE READ, READ ONLY` transaction.
- Role: `postgres` (not superuser, but `BYPASSRLS` and write-capable), because
  it was the only credential available. The read-only transaction guard was the
  only thing preventing writes; a dedicated read-only capture role is preferable
  for future re-captures.
- No session-level `SET` was issued by us. `pg_dump` itself issues its
  standard session `SET`s (`statement_timeout`, `search_path`, …) on its
  own connection, which is closed when it exits.
- Determinism: a second dump taken minutes later was identical after
  normalising pg_dump 17's per-run random `\restrict` / `\unrestrict` key
  lines (normalised SHA-256 prefix `526ADE921166244B` for both).
- Credentials were never printed or written; the dump and inventory were
  scanned for the connection string and password before being saved here.

## Re-capturing

Use the same guarded approach (PostgreSQL 17 client tools; read-only
transaction assertion before any query). Diff against this baseline after
normalising the `\restrict` key lines. Findings from the Phase 0 reviews are
reported in the Phase 0 PR / approval record, not here.
