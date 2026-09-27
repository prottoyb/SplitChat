# ADR-0008: Frontend feature modules and a single data-access boundary

**Status:** Accepted 2026-09-27 (Phase 2; Software Architect: FIT WITH CONDITIONS — all conditions adopted below) · **Detail:** `docs/phase2/plan.md`

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
  app/        routing (lazy routes), layout, providers, cross-feature composition
  shared/
    api/      supabase client, Result<T> with error codes, RPC error mapping
    domain/   money (integer cents), dates
    hooks/    useResource (keyed async data)
    ui/       StateCard, Notice, InlineConfirm, Avatar, …
  features/
    auth/     session context, protected route, sign-in page
    people/   display-name resolution (active profiles + ledger identities)
    groups/   group + membership API, member management, pages
    expenses/ expense API (reads + v2/update/delete), canonical split,
              form domain, expense form (create + edit), pages
    dashboard/, activity/
  features/<f>/api/      the only feature code that touches Supabase
  features/<f>/realtime/ (Phase 6) subscriptions
```

Rules (checked by `src/architecture.test.ts`, no new dependency):
1. **Supabase boundary:** only `shared/api/**`, `features/*/api/**` and
   `features/*/realtime/**` import the Supabase client — including
   `features/auth` (its session/profile calls live in `auth/api`).
2. **Feature boundary:** a feature imports another feature only through
   that feature's `index.ts`. Allowed direction (no cycles):
   `auth ← people ← groups ← expenses ← (balances, settlements) ←
   (dashboard, activity, chat, smart-expense)`. Cross-feature composition
   (e.g. the Phase 5 group workspace) lives in `app/` or pages.
3. **Results:** API functions return `Result<T>` =
   `{ ok: true, value } | { ok: false, code, message }` with `code` in
   `auth | not_found | forbidden | stale | validation | conflict |
   rate_limited | network | unknown`, filled by the shared RPC error map.
   The UI branches on `code`, shows `message`; raw database text never
   reaches the UI.
4. **Money:** integer cents in every type; API modules select explicit
   columns (no `*`) and map rows to typed models at the boundary with
   `readCents`; formatting only via `formatCents`. No float arithmetic on
   money outside `shared/domain/money.ts` (checked).
5. **Names:** `people/api` `resolveDisplayNames(groupId, userIds)` owns the
   rule — active profile names win, gaps filled from
   `get_ledger_identities`, one `FALLBACK_MEMBER_NAME`. A failed profiles
   query fails the view; a failed ledger-identity call logs and falls back.
   Multi-group views make one RPC per group (N+1, acceptable now; a
   batched RPC can come in a later reviewed database batch).
6. **Route data:** `useResource(key, loader)` returns `{ status, data,
   error, refreshing, reload(), setData() }`; a changed key shows loading
   at once; responses after a key change or unmount are ignored;
   `reload()` keeps data and sets `refreshing`. No cache across keys or
   components, no global store. **Data-library triggers** (then an ADR in
   Phase 6 chooses TanStack Query vs the hook): a mutation in one feature
   must update views mounted by another, or realtime events must update
   cached lists across routes. Callers depend only on the return shape.
7. **Expense edit:** `expenses/domain/expenseForm.ts` (pure validation incl.
   the strict date rule, form → `ExpenseInput`), `components/ExpenseForm`
   (`mode: create | edit`), thin edit route. The loaded `updated_at` is
   sent back **as the exact string, never through `Date`** (microsecond
   precision; tested). Payer/participant options = active members plus the
   expense's current payer/participants (former ones labelled). `stale` →
   offer reload, never auto-retry; `forbidden` → message, read-only.
8. **Realtime (Phase 6, reserved):** `features/<f>/realtime/subscribeX(key,
   onEvent): () => void` and a shared `useSubscription`; payloads are
   untrusted in shape (refetch through the API or merge de-duplicated by
   id). Channel authorization is a Phase 6 ADR with security review.
9. **Financial logic (Phases 4, 7):** client money math (split preview,
   balance display) is presentation only; numbers that settlements act on
   come from or are checked by the server (balances RPC preferred, client
   mirror tested against shared vectors). Ledger writes only through
   `expenses/api` (and `settlements/api` in Phase 4). Smart Expense is a
   pure producer of `ExpenseInput` candidates using the same validation
   and the expenses public API — never its own write path. Phase 4
   balances are their own ADR trigger.

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
