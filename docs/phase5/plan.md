# Phase 5 — Group navigation and product UX integration

**Status:** ✅ COMPLETE 2026-09-28 (`3eb228d` implementation + review
fixes; QA/Security PASS, Senior Review APPROVE, UI/UX rendered review
APPROVE AFTER FIXES → fixes verified on re-render). See "Outcome" below.

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

## Outcome (2026-09-28)

**Delivered (all MUST items; SHOULD items except the full panel-style
consolidation):**
- `src/app/workspace/GroupWorkspace.tsx`: `/groups/:id/*` shell —
  breadcrumb, name, role badge, member count and description, **Your
  position** from `get_group_balances` via `loadMyBalance` (same integrity
  checks as the full load; failure shows "Unavailable" + Retry, never a
  number), one primary **+ Add expense**, section links (Overview, Expenses,
  Balances, Activity, Members) with `aria-current`, focus moved to the
  section heading on navigation, active link kept in view on mobile,
  unknown section → Overview. `/groups/:id/expenses/new` stays a focused
  page outside the shell. Section loading/errors stay inside the section.
- Sections: Overview (next step, recent expenses, recent activity,
  members), Expenses (`listMyExpenses(userId, { groupId })` + shared
  `ExpenseList`), Balances (`GroupBalancesSection`, no duplicate header or
  "Your balance"; refreshes the header after a payment), Activity
  (`useActivityFeed`, shared with the global page), Members
  (`GroupMembersSection`, unchanged RPC behaviour).
- Dashboard "Your groups": position per listed group (max 6), each failure
  isolated to its row. Attention links go to the group's Activity section.
- Shared UI: `SectionHeader`, compact `LoadingState`/`ErrorState`;
  link-buttons no longer underlined.

**Rendered review** (`scripts/rehearsal/render-review.mjs`: realistic
synthetic data on SplitChat-Dev, Vite env overridden to Dev, browser
requests restricted to the local app and Dev — anything else fails the
run; 12 screens × desktop 1440 / tablet 900 / mobile 390). Fixed from it:
member names truncated to ~4 characters at every width (a pre-existing
member-row grid bug), dashboard side column overflowing horizontally,
underlined link-buttons, clipped payment-form selects (shorter option
labels), no overflow cue on the mobile section nav (edge fade, snap,
active link scrolled into view), long group names squeezing the dashboard
position.

**Reviews:** UI/UX APPROVE AFTER FIXES (CRITICAL #1, MEDIUM #2–#3 fixed
and verified on re-render; LOW #4 fixed). QA/Security PASS (MEDIUM:
harness guard hardened from a production-ref match to an origin
allowlist). Senior APPROVE (MEDIUM: this outcome; LOW: effect comment).

**Deferred (LOW/OPTIONAL, Phase 8 density/performance pass):**
- Overview and Expenses fetch the group's expenses separately (one extra
  request when switching; no shared cache by design, ADR-0008 rule 6).
- Balances section: slight vertical redundancy on mobile (position box +
  section intro + everyone's balance).
- Overview "next step" repeats the header position in sentence form
  (kept: it carries the action link).
- Long names are ellipsised in the payment "Paid by" select at half
  width (full text in the native option list).
- Panel/stat-card styles are still per-module rather than shared tokens.
