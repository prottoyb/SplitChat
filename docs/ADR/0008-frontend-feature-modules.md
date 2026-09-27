# ADR-0008: Frontend feature modules and a single data-access boundary

**Status:** Proposed 2026-09-27 (Phase 2) · **Detail:** `docs/phase2/plan.md`

## Context
The React SPA talks to Supabase directly (no backend server, ADR-0003).
After Phase 1 the write path is a reviewed RPC contract, but route pages of
700–1200 lines still mix Supabase queries, domain rules, request state and
markup; helpers are duplicated across pages, and each page reinvents
loading, cancellation and error handling.

## Problem
Give the frontend clear boundaries so that financial and authorization-
relevant logic lives in one tested place, pages stay small, and the later
phases (balances, settlements, chat, Smart Expense) can add features
without copying patterns.

## Options considered
1. **Layered folders** (`api/`, `components/`, `hooks/`, `pages/`) across
   the whole app.
2. **Feature modules** (`features/<feature>/` owning its API, domain logic,
   components and pages) plus a small shared kernel.
3. **A data library** (TanStack Query / SWR) as the data layer.
4. **Status quo** with extracted helpers only.

## Decision
Option 2, without a new data library.

```
src/
  app/        routing (lazy routes), layout, providers
  shared/
    api/      supabase client, Result<T>, RPC error mapping
    domain/   money (integer cents), dates
    hooks/    useResource (keyed async data)
    ui/       StateCard, Notice, InlineConfirm, Avatar, …
  features/
    auth/     session context, protected route, sign-in page
    groups/   group + membership API, member management, pages
    expenses/ expense API (reads + v2/update/delete), canonical split,
              form validation, expense form (create + edit), pages
    dashboard/, activity/
```

Rules:
- Only `features/*/api*.ts` (and `shared/api`, `features/auth`) import the
  Supabase client. Components receive data and callbacks.
- API functions return `Result<T>` (`{ ok: true, value } | { ok: false,
  message }`) with user-facing messages from the shared RPC error map; raw
  database messages never reach the UI.
- Money is integer cents in every type; formatting happens only in
  components via `formatCents`.
- A feature may import `shared/*` and another feature's public API (its
  `index.ts`); never another feature's internals.
- Route data uses `useResource(key, loader)`: a changed key renders loading
  at once and responses for an old key are ignored.

## Rationale
Features match how the product grows (the roadmap is feature-by-feature);
co-location keeps each feature's rules, calls and tests together. A data
library would be a new major dependency for needs a ~50-line hook covers
today (no shared cache across pages is required yet); the decision can be
revisited when realtime chat (Phase 6) needs cache updates.

## Consequences
Files move (import paths change once); tests move with their modules.
Pages become compositions. Supabase access is greppable to a handful of
files, which makes authorization review easier.

## Risks
A large mechanical move can hide behaviour changes — mitigated by keeping
existing tests green at every step and by component tests for the split
pages.
