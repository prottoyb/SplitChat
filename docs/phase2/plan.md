# Phase 2 — Frontend / domain consolidation: plan

**Status:** implemented, in review (autonomous programme Phases 2–7,
operator approval 2026-09-27). Branch `feature/phase2-frontend-domain`, cut from `main` at the
Phase 1 merge (`02d6d64`). Coordination: the main session acts as
Engineering Lead and implementer; the Software Architect reviews the module
boundaries (ADR-0008); QA/Security and Senior Review close the phase.

## Starting point (discovery)

- Five route pages hold everything: data access (inline Supabase queries),
  domain logic, state machines and markup — `GroupDetailsPage` 1182 lines,
  `ExpenseDetailsPage` 1031, `AddExpensePage` 809, `ExpensesPage` 726.
- Phase 1 already added a clean client contract for writes
  (`expenseApi.ts`, `membershipApi.ts`, `rpcErrors.ts`, `money.ts`,
  `expenseSplit.ts`, `ledgerIdentities.ts`); reads are still ad hoc.
- Duplicated logic: initials/avatar, split labels, date formatting,
  "SplitChat member" name fallbacks and historical-name resolution,
  success/error banners, confirm-button state.
- Two router packages: `main.tsx` wraps the app in `react-router` v8's
  `BrowserRouter`, `App.tsx` in `react-router-dom` v7's. Both ship in the
  534 kB bundle; only the inner one is used.
- Stale data: pages keep the previous route's data while a new id loads
  (reload keys and `cancelled` flags per page, no shared pattern).
- Expense date is validated only as non-empty.
- No expense edit UI (the M13 RPC is live in production).
- No CI.

## Scope

1. **Architecture (ADR-0008):** feature modules with a small shared kernel
   (see ADR). Pages become thin compositions of feature components.
2. **Data access:** every Supabase read/write goes through a feature API
   module returning `Result<T>`; no component imports the Supabase client.
   Name resolution (active profiles + ledger identities) in one place.
3. **Money:** integer cents end to end; `formatCents` / `readCents` only;
   no float money anywhere (lint-level check by test).
4. **Errors and validation:** one `Result` type and one error mapper;
   validation rules in the domain modules (expense form, dates, email).
5. **Route data:** a `useResource` hook keyed by route params — a new key
   shows loading immediately, late responses for an old key are ignored,
   `reload()` is explicit.
6. **Split pages** into feature components with shared UI primitives
   (state card, notice, inline confirmation, avatar) and consistent
   loading / error / empty states.
7. **Dates:** strict `YYYY-MM-DD` calendar validation with a sensible range
   (not before 2000-01-01, not more than one year ahead); local "today".
8. **Expense edit UI:** one `ExpenseForm` for create and edit; edit keeps
   former-member participants/payer as the server allows, sends the loaded
   `updated_at` and handles `stale_expense` / `forbidden`.
9. **Bundle:** remove the unused router package and the outer router;
   lazy-load route pages; target no >500 kB chunk warning.
10. **Tests:** unit tests for domain modules and hooks; component tests for
    the form, member management and details views; keep the shared split
    vectors.
11. **CI:** GitHub Actions running lint, build, tests and the database
    harness on pushes and PRs (free tier; no paid service).

Out of scope: new product features beyond edit UI; database changes (none
planned — any need is recorded for a later reviewed batch); visual
redesign (Phase 5).

## Risk tier

STANDARD overall (frontend refactor, UI, CI). The expense edit UI and the
data layer touch authorization-relevant flows, so QA/Security reviews the
phase as well (server enforcement unchanged).

## Checkpoints

CP2-1 architecture + shared kernel · CP2-2 groups feature · CP2-3 expenses
feature + edit UI · CP2-4 routing/bundle · CP2-5 CI · CP2-6 reviews,
docs, phase checkpoint.

## Outcome (implementation)

| Item | Result |
|---|---|
| Architecture | ADR-0008 accepted; `src/{app,shared,features/{auth,people,groups,expenses,dashboard,activity}}`; boundaries enforced by `scripts/architecture.test.mjs` |
| Data access | all Supabase calls in `features/*/api` + `shared/api`; `Result<T>` with error codes; `guard()` maps thrown errors to `network` |
| Names | `features/people` — one rule for active and historical names |
| Money | integer cents end to end; float arithmetic on money checked out of the codebase |
| Route data | `useResource`; stale-route data fixed (loading on key change, late responses ignored) |
| Pages | GroupDetails 1182 → ~180 lines + 4 components; ExpenseDetails 1031 → ~230; AddExpense 809 → New/Edit pages (~90/130) + `ExpenseForm`/`SplitPreview` |
| Dates | strict `YYYY-MM-DD`, 2000-01-01 … today + 365 days, inline errors |
| Edit UI | `/expenses/:id/edit`; exact `updated_at`; stale → reload; forbidden → read-only; former members kept and labelled |
| Auth | Supabase Auth behind `auth/api`; fixed messages; sign-up never reveals whether an email exists |
| Bundle | duplicate router removed; lazy routes; no >500 kB warning (entry 450 kB) |
| Tests | Vitest 286 (19 files) incl. hook, API, form, page and architecture tests; test:db unchanged 23/23 |
| CI | `.github/workflows/ci.yml` (lint, build, test, audit; database harness on PostgreSQL 17) |

No database change was needed in Phase 2.
