# ADR-0007: Database migration test environment

**Status:** Accepted 2026-09-26 (Phase 1 design approval) · **Date:** 2026-09-26 · **Detail:** design §C, §D

## Context
No Docker, no Supabase CLI, no CI, no pgTAP. PostgreSQL 17 is installed
locally. Migrations touch RLS, grants and an `auth.users` trigger and must be
proven before any prod apply. Operator: Docker must not become a runtime
requirement.

## Problem
Test migrations, RLS and financial invariants safely and repeatably before
production.

## Options considered
1. A separate Supabase cloud dev/test project.
2. The local Supabase stack (Docker).
3. A throwaway local PG17 cluster + Supabase compatibility shim + plain-SQL
   assertions.
4. WSL PG17 + pgTAP + shim.

## Decision
- **3** is the mandatory gate for every migration and PR
  (`npm run test:db`; Node-only runner that refuses non-local targets).
- **1** is the pre-prod rehearsal for each batch, subject to operator
  approval to create it.
- **4** only if CI later needs pgTAP. **2** is not adopted.

## Rationale
3 is fast, deterministic, isolated, needs no Docker and uses installed tools.
Its gaps (PostgREST, GoTrue, platform-managed grants) are exactly what the
rehearsal project covers.

## Consequences
A maintained shim mirroring Supabase roles and `auth`, with a self-test
against the Phase 0 inventory. No new npm dependencies for the harness.

## Risks
Shim drift from the real platform (self-test; rehearsal). Without the dev
project, M11 and CLI behaviour stay unproven against real Supabase. No CI —
a tracked risk until a workflow is added.
