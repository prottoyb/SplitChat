# Phase 5 — Group navigation and product UX integration

**Status:** not started (waits for Phase 4 completion). Design brief from
the UI/UX product designer received 2026-09-28 (code-level review; no
rendered screenshots yet — request desktop + mobile renders before
sign-off).

## Design brief (summary)

**MUST**
- Group workspace shell at `/groups/:id` with nested section routes:
  Overview (index), Expenses (group-scoped), Balances, Activity
  (group-scoped), Members; Chat slot reserved for Phase 6 (tab omitted
  until then; Smart Expense lives inside Chat in Phase 7).
- One persistent header: breadcrumb `Groups / {name}`, group name, my
  position as text ("You owe $X" / "You're owed $X" / "Settled up"), single
  primary action **+ Add expense**; section actions (Record payment, Add
  member) stay in their section.
- Section navigation = links with `aria-current="page"` (not ARIA tabs);
  mobile: one horizontally scrollable row of links.
- Focus moves to the section heading on navigation.
- Loading/error states scoped to the section body; header and tabs stay.
- Existing URLs (`/groups/:id/expenses/new`, `/groups/:id/balances`) keep
  working; remove the per-page breadcrumb duplicates.

**SHOULD**
- Dashboard "Your groups" rows show per-group position, fetched only for
  the visible groups (max 6), a failed balance degrades that row only.
- Shared `PageHeader`/`SectionHeader` for the repeated topbar/eyebrow
  markup; consolidate panel/stat-card styles into shared UI tokens.
- Group-scoped Expenses/Activity reuse the existing list components.
- Balances section drops its own header, breadcrumb and duplicate "Your
  balance" block (the shell shows the position).

**COULD**
- Overview: fewer stat cards (role folded into the header badge).
- Shared owes/owed text+tone helper (balances feature already has
  `balanceText`).
- Follow-up ticket (out of scope): verify sidebar behaviour on narrow
  viewports.

No API, auth or schema changes are proposed.
