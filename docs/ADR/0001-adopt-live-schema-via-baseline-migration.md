# ADR-0001: Adopt the live Supabase schema via a repaired baseline migration

**Status:** Proposed (Phase 1 design gate) · **Date:** 2026-09-26 · **Detail:** `docs/phase1/design.md` §A1

## Context
The production `public` schema was built by hand and has no migration history
(`supabase/baseline/`, Phase 0). `engineering.md` §11 and `database.md` require
changes to be reproducible from the repository.

## Problem
Bring the schema under `supabase/migrations/` without re-running DDL on prod,
and make local/dev/CI environments reproducible.

## Options considered
- **A.** A baseline migration that reproduces prod exactly, recorded on prod
  with `supabase migration repair` (never executed there); fixes as later
  migrations.
- **B.** Squashed init for fresh environments only.
- **C.** Declarative schemas.
- **D.** `supabase db pull`.
- **E.** Home-grown runner and history table.

## Decision
A. The baseline is hand-converted from the reviewed Phase 0 dump with every
exclusion listed (`\restrict`, `CREATE SCHEMA public`, platform ACLs and
default privileges, session-level settings), plus the `on_auth_user_created`
trigger. It contains no fixes and is deliberately non-idempotent (no
`OR REPLACE` / `IF NOT EXISTS`). A local round-trip dump must equal the
baseline.

## Rationale
One shared history for prod and every other environment; "adopt as-is" is
separated from remediation; every later change takes the same reviewable
path. B leaves prod hand-managed; C and D need Docker or have diff gaps on
policies, grants and auth triggers; E diverges from Supabase tooling.

## Consequences
All prod changes go through migrations with per-apply execution approval; no
dashboard schema edits (operator decision). The CLI has no down migrations,
so each fix carries a tested rollback script, applied as a forward migration.

## Risks
- Prod drift between capture and repair → drift check (F-R1) immediately
  before.
- Accidental re-apply of the baseline → fails loudly; `--dry-run` first.
- CLI needing Docker for `repair`/`push` → verify in rehearsal; psql fallback.
- PG version skew → pin 17.
