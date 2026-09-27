---
paths:
  - "database/**"
  - "db/**"
  - "prisma/**"
  - "migrations/**"
  - "supabase/**"
  - "**/*.sql"
---

# Database Engineering Standards

## Data Integrity

Use appropriate:

- primary keys
- foreign keys
- constraints
- unique constraints
- indexes
- validation

Do not rely entirely on application code for critical data integrity.

---

## Migrations

Database schema changes must be applied through a migration in the
repository, not executed manually against production.

This is the database-specific instance of the general production-change
control defined in `.claude/rules/engineering.md` (Build, Deployment and
Environments) — see that section for the full policy.

---

## Security

When the database engine supports row-level security, per-role grants, or
equivalent access controls (e.g., PostgreSQL RLS, MySQL grants, a managed
database's IAM policies), use them for tables holding multi-tenant,
sensitive, or regulated data. Do not rely on application-layer checks
alone for these cases.

Never assume the frontend protects database data.

---

## Transactions and Concurrency

Use a transaction whenever a change involves multiple statements that
must succeed or fail together.

Whenever more than one process or request can modify the same row(s) at
the same time, use appropriate isolation, locking, or an optimistic
concurrency check (e.g., a version or `updated_at` column) to prevent
lost updates.

Avoid long-running transactions that hold locks across external calls or
user think-time.

---

## Queries

Queries should be:

- understandable
- appropriately indexed
- parameterized
- reviewed for unnecessary data retrieval

Avoid selecting significantly more data than required.

---

## Destructive Changes

Before destructive schema changes:

- understand dependencies
- assess migration impact
- consider existing production data
- provide an appropriate migration strategy, including a rollback path
  where feasible

A destructive change — dropping or truncating a table, dropping or
renaming a column in use, or any irreversible data deletion or
transformation — must never be executed against production data without
the specific execution approval defined in `CLAUDE.md`'s Human Approval
section, obtained immediately before execution. This applies even when
the change is technically correct and well-tested.

Approval of the pull request containing the migration is **not**
sufficient by itself unless that approval explicitly states it also
covers execution — PR approval and execution approval are different
gates (`CLAUDE.md`). This is Mandatory Gate #5.

Never casually delete production data.

---

## Concurrent Migrations

When multiple agents may be working in parallel, migrations affecting
the same tables or schema objects must not be applied concurrently. The
coordinator sequences them (`.claude/rules/git.md`'s Shared Resources and
Merge Ordering). Sequencing is coordination only — it does not
substitute for the destructive-change approval above, which each
migration still requires on its own.