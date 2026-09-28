# Phase 9 plan — Product Experience, UX & Functional Refinement

Status: **approved with operator decisions D1–D6** (2026-09-29, see "Operator decisions" below, which take precedence over the proposal text).
Scope and decision boundary: `docs/phase9/scope.md`. Evidence:
`docs/phase9/ux-review.md`. Branch `feature/phase9-product-ux` from `main`
@ `dfec625`. Production is at M23 and is not touched. No deployment.

## Goal

Turn a set of correct screens into an app a flatmate opens every week. It
should tell you what needs you, show where you stand in one glance, and
work comfortably on a phone. The financial and security model does not
change.

## Operator decisions (2026-09-29) — take precedence

- **D1 APPROVED:** mobile bottom tab bar with a compact top bar.
- **D2 APPROVED:** primary group navigation is **Overview · Expenses ·
  Balances · Chat**. Members is not a primary tab: it lives in a group
  menu/settings area reached from the (group) top bar. Activity is
  secondary: surfaced inside Overview and/or through a dedicated
  secondary action.
- **D3 APPROVED IN PART:** profile page, profile/account editing as
  appropriate, and password reset/change flow are in Phase 9.
  **Self-service account deletion is deferred** (ownership/history/
  security implications). Production Auth configuration for password
  reset is a later explicit production gate; build and test against
  SplitChat-Dev first.
- **D4 APPROVED:** owners may rename a group through a new owner-only
  server-side database function and a new migration. It goes through
  security review and Senior Review and is rehearsed on SplitChat-Dev.
  Not applied to production without later approval.
- **D5 DEFERRED:** no trip start/end dates in Phase 9.
- **D6 APPROVED:** the old release-readiness work becomes **Phase 10 —
  Release Readiness, Deployment & Portfolio Presentation**.
- **Order of work:** Increment 0 (overflow bug fix + design-token/system
  pass) now; then wireframes and IA for the approved decisions; then a
  representative implementation slice; the full redesign only after that
  slice is reviewed. The designer leads product-experience direction.
  Continue autonomously; stop only for a new major product, architecture,
  security, database-semantics, production or deployment decision.
  Checkpoint commits, and push the feature branch at meaningful
  milestones.

## Operator decisions as proposed (historical)

Each decision has a recommendation. Everything else in this plan is inside
the autonomous boundary.

| # | Decision | Recommendation | Alternatives |
|---|---|---|---|
| **D1** | **Mobile app shell:** replace the clipped horizontal nav strip with a **bottom tab bar** (Home · Groups · Expenses · Activity) and a compact top bar (logo mark + account menu, no tagline) | Yes. It is the standard mobile pattern, removes one of the two clipping strips, and frees about 100 px on every screen | Keep the top strip with stronger scroll cues (weaker; still clips) |
| **D2** | **Group workspace tabs**, 6 → 4. The designer and coordinator differ on which four | **Option B (coordinator):** Overview · Expenses · Balances · Chat. Activity folds into Overview ("All activity →" keeps the full page). Members moves to the group header ("4 members · Manage") plus the Overview members card, and the solo-group empty state already routes there. Reason: the expense list is the core ledger, checked constantly; Members is used around setup | **Option A (designer):** Overview · Balances · Chat · Members, with Expenses and Activity reachable only through Overview links and the global nav. Keeps Members one tap away but demotes the ledger. **Option C:** keep 6 tabs, make the bar scroll properly |
| **D3** | **Account features.** (a) Profile page: display name, sign out. (b) Forgot / change password: code on Dev now; production needs Auth redirect-URL and email/SMTP config at release. (c) Self-service **account deletion**: needs an Edge Function holding the service-role key and an ADR | (a) and (b) yes, in Phase 9. **(c) not in Phase 9**: it is a new backend component and an irreversible flow, and it depends on the orphaned-group policy (DS-3). Prepare a separate proposal | Include (c) now as a separately approved, SENSITIVE workstream |
| **D4** | **Owners can rename a group / edit its description.** Needs a new owner-only RPC and a migration adding a `group_updated` activity kind, rehearsed on Dev only | Yes. It restores a capability removed in M6 for hardening, adds no new role, and gets a security review | Leave groups unrenamable (a real annoyance: typo'd names are permanent) |
| **D5** | **Trip dates** (start/end on a group) | **Defer.** No proven need; generic groups serve trips | Display-only dates on the D4 RPC |
| **D6** | Roadmap: the old Phase 9 (release readiness: hosting, README, demo, release validation) becomes **Phase 10** | Confirm | Fold release readiness into the end of Phase 9 |

## Proposals

Layers: FE = frontend only; MIG = new migration (Dev only). Class: **A** =
autonomous under `scope.md`, **H** = needs human approval.

### Must

| # | Proposal | Real user problem | Layer | Effort | Class |
|---|---|---|---|---|---|
| P1 | Mobile shell: bottom tab bar + compact top bar (D1) | Navigation clipped; chrome wastes space on every screen | FE | M | A once D1 is decided |
| P2 | Group workspace: 4 tabs (D2); Activity folded into Overview; Members from the header | Six tabs clip on mobile; the tab you need depends on luck | FE (routes, tests) | M | A once D2 is decided |
| P3 | Full-height chat on mobile: the group header collapses to one line in Chat, and the explainer moves to the empty state and composer hint | About 350 px left to read a conversation | FE | S–M | A |
| P4 | **"Needs you" on the dashboard:** proposals you can act on (yours, or any in a group you own), each with a direct link; "You owe X in Group" with a Settle link; the existing membership notices. Plus a pending-proposal badge on each group's Chat tab | Pending money decisions are invisible outside one tab; people miss them | FE (select on `expense_candidates`, RLS-scoped; per-group subscription for the badge) | M | A |
| P5 | **Open proposals strip** pinned above the chat composer (collapses when there are none); jump to the card | Proposals scroll away under conversation | FE | M | A |
| P6 | Dashboard headline: **overall position across groups** ("Overall you're owed $953.23 · 2 groups"), replacing "Changes this week" | No single "where do I stand" number | FE (per-group positions already loaded; display-only sum, no new financial concept) | S | A |
| P7 | Fix: dashboard "Your groups" rows overflow their panel at desktop width | Visual bug | FE | S | A |

### Should

| # | Proposal | Real user problem | Layer | Effort | Class |
|---|---|---|---|---|---|
| P8 | Design-token pass: secondary/tertiary text scale, named type scale, shared `StatCard`, `PositionChip` and `ListRow`; consistent link styling (no raw browser-blue underlines) | Everything secondary looks equally (un)important; per-module drift (Phase 8 deferred) | FE | M | A |
| P9 | Say your position once: header chip only; the Overview banner becomes a next-action card (Settle up / Add expense / Add members) | Same number repeated 2–4 times | FE | S | A |
| P10 | Balances on mobile: "Record" opens the pre-filled form as a focused sheet (desktop keeps the side panel); history easier to reach | Tap Record, nothing visible happens; the form is 800 px away | FE | M | A |
| P11 | Add expense on mobile: compact split preview until there is data; replace the "Equal split" pill with plain copy | CTA pushed off-screen; a pill that looks like a broken selector | FE | S | A |
| P12 | Profile/account page: display name, email (read-only), sign out, change password (D3a/b) | You cannot fix your own name; no password recovery | FE (Supabase Auth client; column grant exists) | M | A on Dev; production Auth config H at release |
| P13 | Forgot-password flow on the login page (D3b) | Locked-out users have no path | FE + production Auth config | S | Code A; enablement H |
| P14 | Owner rename/description (D4): `update_group_details` RPC, `group_updated` event (ids-only payload), UI in the group header menu | Typos and changed purposes are permanent | MIG + RPC + FE; **SENSITIVE**; short ADR | M | A once D4 is decided; Dev only |
| P15 | Display-name rules: 1–80 characters, trimmed, "Deleted user" reserved for tombstones (CHECK exempting deleted rows, `NOT VALID`; clean `handle_new_user` input) | Impersonating a deleted user; blank names (Phase 8 deferred) | MIG; **SENSITIVE** | S–M | A on Dev. Production VALIDATE / row fixes H |
| P16 | Groups page shows your position per group | Browsing groups loses the at-a-glance status | FE | S | A |

### Could

| # | Proposal | Layer | Class |
|---|---|---|---|
| P17 | "This month vs last month" under your monthly share (worded as "in your current groups") | FE | A |
| P18 | Sign/arrow glyph alongside balance colour and words | FE | A |
| P19 | Copy pass: owner "recording a payment between two others" hint; "old proposal" suggested action (Phase 8 deferred); one-line value statement on mobile login | FE | A |
| P20 | Hide activity noise on tiny/new groups ("created the group" folded into one line) | FE | A |

### Needs approval / deferred

| # | Proposal | Why |
|---|---|---|
| P21 | Self-service account deletion (Edge Function + service role + ADR) | New backend component, irreversible; depends on orphaned-group policy (DS-3). **H** |
| P22 | Trip dates | No proven need (D5) |

### Removed, demoted or rejected

- **Demoted:** group Activity tab (into Overview); "Changes this week"
  stat; the "Equal split" pill; the chat explainer banner (moves to the
  empty state and composer hint).
- **Kept but not invested in:** chat in solo groups. It is harmless, and
  a consistent structure matters more.
- **Rejected:**
  - a notifications page or bell (the dashboard "Needs you" solves the
    real problem);
  - a quick-add expense modal (duplicates a good form and risks skipped
    participant review);
  - charts (one delta line is enough);
  - merging Dashboard and Groups;
  - exact/percentage splits (out of scope per the product vision);
  - email/push reminders ("nudge Sam to pay"). A real want, but it is a
    new external service: **H**, not proposed for Phase 9.

## Engineering constraints

- No change to balance, settlement, expense-ownership or permission
  semantics. The cross-group total in P6 is a display sum of existing
  per-group positions.
- New migrations only (P14, P15), rehearsed on SplitChat-Dev. Production
  needs separate release approval.
- P12–P15 are SENSITIVE and go through `project-security-review`. The
  rest is STANDARD with Senior Review.
- Keep ADR-0008 placement: cross-feature composition such as the
  dashboard attention list, the badge and the workspace tabs lives in
  `src/app/` or the dashboard.
- Each increment: `npm run lint`, `npm run build`, `npm test` (plus
  `test:db` for migrations), rendered review on Dev, and the a11y audit
  before sign-off.

## Sequencing

Each increment is shippable on its own.

0. **Foundation:** P7 bug, P8 tokens and shared components.
1. **Shell and workspace IA** (after D1/D2): P1, P2, P3, P9.
2. **Attention and Smart Expense:** P4, P5, P6.
3. **Flow polish:** P10, P11, P16, P17–P20.
4. **Account and group management** (after D3/D4; SENSITIVE reviews):
   P12, P13, P14, P15.

**Next deliverable after decisions:** wireframes for the mobile shell,
group workspace, dashboard "Needs you" and chat with the proposals strip,
plus the design-token/component spec (`docs/phase9/wireframes.md`,
`docs/phase9/design-system.md`). Increment 0 can start in parallel
because it depends on no decision.

## Review record — Increment 0 and representative slice (2026-09-29)

Commits `b69cf89`, `ade001d`, `53a7c0b`; correction pass in the next
commit.

- **UI/UX Product Designer: PASS WITH CHANGES.** All slice acceptance
  checks pass, including the much taller mobile chat and four unclipped
  tabs.
  - **MEDIUM (fixed):** the login segmented control lost its visible
    container. The token pass mapped the auth page background to the same
    token as the control's fill.
  - **Coordinator follow-up (fixed):** the same collapse was checked
    everywhere. Three more containers (chat composer, expense total
    summary, rejected proposal card) now use `--surface-page`, so chips
    inside them stay distinct.
  - **LOW (deferred to the rollout):** the top bar shows the brand, not
    the group, when scrolled inside a workspace.
  - **LOW (deferred to the rollout):** secondary pages (Members, Activity,
    Settings) repeat the full group header. A lighter header for them is
    planned with the Overview work.
  - **OPTIONAL:** the breadcrumb replaces the literal "← Back to <group>"
    mock. Accepted.
- **Senior Reviewer: APPROVE.** No CRITICAL/HIGH/MEDIUM findings. Menu
  semantics and lifecycle, shellMode routes, focus management, the
  `--chat-height` hand-off and test quality were all checked.
  - **Residual risk (LOW):** the reviewer diffed 2 of 19 migrated
    stylesheets in full. The token guard test bounds that risk, and the
    designer's finding above was the kind it missed. The coordinator's
    collapse sweep covers the rest of that class.
- **Verification:**
  - lint, build and Vitest 573/573;
  - on SplitChat-Dev: E2E 20/20, a11y audit 0 findings, and a rendered
    review with no overflow and nothing outside its panel.

**Outcome:** the representative slice is accepted. The rollout continues
with increments 1–4.
