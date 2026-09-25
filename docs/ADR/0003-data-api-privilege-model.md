# ADR-0003: Data API privilege model

**Status:** Proposed · **Date:** 2026-09-26 · **Detail:** design §A2, §A6, M2/M6/M8/M10

## Context
Postgres default privileges give `anon` and `authenticated` ALL on every new
table and EXECUTE on every new function in `public` (L1237-1290). Result:
GRANT ALL including TRUNCATE (QS-5), an anon-callable SECURITY DEFINER
membership oracle (QS-2), and inconsistent `search_path`.

## Problem
Make least privilege the default so current and future objects are safe
without per-object vigilance.

## Options considered
1. Revoke today's grants only.
2. Revoke, fix default privileges, move internal helpers to a non-exposed
   `private` schema, add guard tests.
3. A separate API schema with views over private tables.

## Decision
2.
- `anon`: USAGE on `public` only.
- `authenticated`: SELECT on the five tables; column-level
  `INSERT(name, description, created_by)` on `groups` and
  `UPDATE(full_name, avatar_url)` on `profiles`; EXECUTE on an allowlist of
  RPCs. No TRUNCATE/REFERENCES/TRIGGER for client roles.
- Helpers live in `private` (not exposed by the Data API). Client-callable
  functions never accept an arbitrary user id.
- Every function uses `search_path=''`; every `CREATE FUNCTION` is followed
  by explicit REVOKE/GRANT. Default privileges for `postgres` are revoked.
- RLS policies use set-based, caller-scoped helpers.

## Rationale
Option 1 leaves every future migration insecure by default; option 3 adds a
second read surface and a large refactor with no Phase 1 need.

## Consequences
New tables and functions need explicit grants (by design). A structural
guard test (S2) runs on every migration.

## Risks
`supabase_admin` default privileges are likely not alterable by `postgres` —
mitigated by guard test S2. `private` must stay out of the Data API's exposed
schemas (manual prod check F-R5).
