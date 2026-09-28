# Phase 9 — UX/product review (2026-09-29)

Evidence behind `docs/phase9/plan.md`. The UI/UX Product Designer led the
review. The coordinator checked its claims against the screenshots and
code. The Software Architect assessed backend implications.

## Method

- **Rendered review on SplitChat-Dev only:**
  `scripts/rehearsal/render-review.mjs` with a 17-route set, 51 full-page
  screenshots at 1440 / 900 / 390. Only localhost and SplitChat-Dev were
  reached, and no page overflowed horizontally.
- **Seeded data:** a 4-person flat with expenses, a settlement, chat and
  Smart Expense proposals in each state; a trip group owned by someone
  else with a long name; an empty solo group; a missing group; the login
  page.
- **Not rendered, reviewed from code only:** expense details, edit
  expense, edit proposal, sign-up mode, loading states. Screenshot these
  before the design step signs off.
- Screenshots stay in the session scratchpad, never the repo.

## Verdict

Each screen is clean and individually well built: good empty and error
states, consistent cards, a strong add-expense form. The product still
reads as a set of correct screens rather than an app someone opens every
week. The main reasons:

1. **Nothing tells you what needs you.** Pending Smart Expense proposals
   only exist inside one group's Chat tab. The dashboard's "Needs your
   attention" shows membership notices only.
2. **Mobile navigation is cramped.** There are two stacked horizontal
   strips that clip: the app nav, then six group tabs.
3. **Mobile chat is squeezed.** Brand header, group header, tabs, title
   and explainer leave roughly 350 px of message area at 390 × 844
   (`flat-chat-mobile.png`).
4. **Repeated numbers.** Your position appears in the group header and
   again on Overview, Balances and "Everyone's balance". Recent expenses
   and recent activity largely repeat each other on Overview.
5. **Basic account and group management is missing.** There is no
   profile page (display name), no forgot or change password, no
   self-service account deletion, and a group cannot be renamed.

## Findings by area

Severity uses the `.claude/rules/engineering.md` scale applied to UX
impact. "Coord." marks a coordinator correction or addition to the
designer's report.

| Area | Finding | Sev. |
|---|---|---|
| Navigation (mobile) | App nav is a horizontal strip with only a fade cue. "Expenses" and "Activity" are clipped at rest (`dashboard-mobile.png`) | HIGH |
| Navigation (mobile) | The six group tabs clip too. **Members, needed right after creating a group, is the hardest to reach** (`flat-overview-mobile.png`, `flat-members-mobile.png`) | HIGH |
| Navigation (mobile) | Coord.: the brand header and tagline take about 140 px on every screen | MEDIUM |
| Chat (mobile) | Coord.: message area is about 350 px tall under stacked chrome. The composer is fine, but reading context is poor | HIGH |
| Chat / Smart Expense | Proposals and conversation share one feed with no "still needs action" view. An open proposal scrolls away under chat | HIGH |
| Chat / Smart Expense | No pending indicator on the Chat tab or anywhere outside it | MEDIUM |
| Dashboard | "Needs your attention" ignores the actionable things: proposals you can approve or complete, and money you owe | MEDIUM |
| Dashboard | Coord.: there is no overall position across groups ("overall you're owed $953.23"), the headline number of a splitting app. "Changes this week: 16" is a vanity count | MEDIUM |
| Dashboard | Coord.: in "Your groups", rows extend past the right edge of their panel at 1440 (`dashboard-desktop.png`) | MEDIUM (bug) |
| Dashboard | Activity group links are underlined browser-blue, unlike every other link | LOW |
| Group Overview | Position appears in the header chip and again in the Overview banner (mobile: stacked). Recent expenses and recent activity overlap | MEDIUM |
| Balances | Designer said HIGH. Coord.: on desktop it is reasonable (suggestions, everyone's balance and the form side by side). On mobile, the form sits far below the "Record" buttons that fill it, with no scroll or focus link between them. Payment history is last | MEDIUM |
| Settlements | Coord.: permission is **not** an open question. `record_settlement` allows payer, payee or owner only (M17), and the form mirrors that (`SettlementForm.tsx:42-44`). Only owners see the any-pair option, and it has no explanation | LOW (copy) |
| Expense form | Empty split-preview card pushes "Create expense" down on mobile | MEDIUM |
| Expense form | The "Equal split" pill looks like a one-option selector | LOW |
| Groups page | No per-group position (the dashboard shows it) | LOW |
| Members | Content and help text are good. The problem is only discoverability (above) | — |
| Activity | Clean, and the global group filter is useful. "Created the group" and "added X" rows dominate new groups | LOW |
| Auth | Strong desktop layout. Mobile drops all explanation of what SplitChat does | LOW |
| Account | Coord.: no profile/account page. You cannot change your display name, cannot reset a forgotten password, and cannot delete your account without an operator | HIGH (product gap) |
| Group management | Coord.: owners cannot rename a group or edit its description (the owner UPDATE policy was removed in M6) | MEDIUM (product gap) |
| States | Empty and error states are exemplary (`solo-overview`, `solo-chat`, `missing-group`). Loading states were not captured | — |
| Visual consistency | One grey for all secondary text. Stat and position cards are implemented per module (Phase 8 deferred) | MEDIUM |
| Accessibility | Designer said "status by colour alone". Coord.: incorrect, since the words "owes" / "are owed" / "You owe" are always present. A sign or icon would still help scanning | LOW |

## Backend implications (Software Architect, verified against migrations)

| Candidate | Layer | Class |
|---|---|---|
| Pending proposals on dashboard and Chat badge | Frontend only. Plain select on `expense_candidates`, where RLS limits rows to active groups (M19 `:171`, M8). Badge needs a per-group subscription in the workspace (client only). The dashboard refetches on focus | AUTONOMOUS |
| This month vs last month | Frontend only (`listMyExpenses` `since` = 1st of last month). The delta excludes groups you have left, so word it carefully | AUTONOMOUS |
| Edit own display name | Frontend only (column grant M6 `:26` plus own-row policy) | AUTONOMOUS |
| Reserve "Deleted user", name length/trim | New migration: CHECK exempting tombstoned rows (the deletion trigger writes that name), `NOT VALID`; `handle_new_user` cleans input. SENSITIVE | AUTONOMOUS on Dev. VALIDATE and any row rewrite in production need approval |
| Forgot / change password | Frontend (Supabase Auth client). **Production Auth redirect URLs and email/SMTP config are operator-gated.** Custom SMTP = new external service | Code AUTONOMOUS. Enabling in production: HUMAN |
| Delete my account | **Edge Function with service role** (first server-side code and first service-role secret in use). Keeps the M11/M16 trigger. ADR required | HUMAN |
| Owner renames group / edits description | Owner-only SECURITY DEFINER RPC plus a new `group_updated` event kind (migration alters `group_events_kind_check`; ids-only payload). SENSITIVE | AUTONOMOUS (borderline: restores a pre-M6 owner capability, no new role). Surfaced to the operator anyway |
| Trip start/end dates | Additive nullable columns written via the rename RPC | AUTONOMOUS only if display-only |

Data caveat: proposals never expire. A proposal whose people have left
stays `proposed` and cannot be approved (`invalid_participants`). An
attention list must offer Reject, and should only list proposals the user
can act on: their own, or any in a group they own
(`can_manage_candidate`).
