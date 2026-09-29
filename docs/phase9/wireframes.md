# Phase 9 — wireframes and information architecture

Author: UI/UX Product Designer; coordinator corrections are marked
"Coord.". Implements operator decisions D1–D4 (`plan.md`). Tokens and
components: `design-system.md`.

## Routes (unchanged set, new entry points)

`/groups/:groupId/*` stays owned by `GroupWorkspace`. The sub-routes
`members` and `activity` **keep working as deep links**. D2 only changes
which routes are primary tabs. New routes:

- `/profile`
- `/reset-password` (the target of the emailed link)
- `/groups/:groupId/settings`

## 1. App shell

**Desktop (≥ 721 px):** keep the dark sidebar. D1 is a mobile decision.

**Mobile (≤ 720 px):**

```
┌───────────────────────────────────┐
│ [S]  Flat 4B 21              (PR) │  compact top bar ≈ 52px, sticky:
├───────────────────────────────────┤  brand mark · page/group label · account menu
│                                   │
│            page content           │
│                                   │
├───────────────────────────────────┤
│  ⌂       ◎        ↔        ○      │  bottom tab bar 56px + safe-area
│ Home   Groups  Expenses Activity  │
└───────────────────────────────────┘
```

- **Top bar:** no tagline. The account menu (avatar) holds Profile and
  Sign out.
- **Bottom bar:** exactly the four D1 items. The active item is filled.
  Uses `env(safe-area-inset-bottom)`. No transition under reduced
  motion.
- **Where actions live:** "Create group" stays on the Groups page (and
  the dashboard). "Add expense" is the group header's primary action.
- **Bottom bar hidden** in group Chat, on full-page expense forms, and
  under an open Sheet.

## 2. Group workspace

**Header**

- Desktop: breadcrumb, then name + role, then position chip, then
  "+ Add expense", then the **group menu (⋯)**.
- Mobile: "← Groups", the name truncated, and ⋯. On the next line, the
  position chip and "+ Add expense".
- The member count ("4 members") also links to Members.

**Primary tabs (D2):**

```
Overview · Expenses · Balances · Chat(2)
```

All four fit at 390 px without scrolling. The Chat badge shows open
proposals the user can act on (P4).

**Group menu**, built on the `Menu` component:

```
┌──────────────────────┐
│ Members          4   │  → /groups/:id/members
│ Activity             │  → /groups/:id/activity
│ ──────────────────── │
│ Group settings       │  → /groups/:id/settings (everyone; editable by owner)
└──────────────────────┘
```

- Coord.: "Leave group" already lives in the Members page
  (`MembershipPanel`). It stays there and is not duplicated in the menu.
- Secondary pages (Members, Activity, Settings) show "← Back to <group>"
  and no tab is highlighted.

## 3. Overview (P9; Activity surfaced)

```
┌───────────────────────────────────┐
│ Next step                         │  one card, highest priority only:
│ Sam owes you $219.74   [Record]   │  you owe → Settle up · others owe you → Record
├───────────────────────────────────┤  no expenses → Add expense · solo → Add members
│ Recent expenses        All →      │
├───────────────────────────────────┤
│ Recent activity        All →      │  Activity is secondary: here and in the menu
├───────────────────────────────────┤
│ Members (4)            Manage →   │
└───────────────────────────────────┘
```

Your position is stated once, in the header chip. The old banner that
repeated it is removed.

## 4. Dashboard: "Needs you" and overall position (P4, P6)

```
┌──────────┬──────────────────────┬──────────┐
│ Groups 3 │ Overall: owed $953.23│ This month│  P6 replaces "Changes this week"
│          │ across 2 groups      │ $1,146.77 │
├──────────┴──────────────────────┴──────────┤
│ Needs you                                  │
│ • Proposal "pizza" $42.00 · Flat 4B        │
│   ready to review            [Review →]    │
│ • "Parking" needs who shares it [Add →]    │
│ • You owe Alex $439.59 · Byron  [Settle →] │
│ • Alex added you to Byron Bay…             │
├────────────────────────────────────────────┤
│ Recent activity   │ Your groups (fixed P7) │
└────────────────────────────────────────────┘
```

- Coord.: the dashboard **links** to the proposal (chat, scrolled to the
  card) or to the settle form. It never approves, rejects or records in
  one tap. Approval stays an explicit review of the full draft (product
  rule).
- Only proposals the user can act on are listed: their own, or any in a
  group they own.
- **Empty:** "Nothing needs you right now." **Loading:** skeleton rows.
  **Error:** compact `ErrorState` with Retry.

## 5. Chat on mobile (P3, P5)

```
┌───────────────────────────────────┐
│ ← Flat 4B 21 · Chat           ⋯   │  one-line header; no app top/bottom bars
├───────────────────────────────────┤
│ 2 open proposals            ▾     │  P5 strip; tap an item → scroll to its card
├───────────────────────────────────┤
│                                   │
│  messages (fills the remaining    │
│  height)                          │
│                                   │
├───────────────────────────────────┤
│ [ Write a message…       ] [Send] │
└───────────────────────────────────┘
```

- With no open proposals the strip is not rendered.
- The explainer text moves to the empty state and the composer
  placeholder.
- On desktop the strip sits above the composer inside the chat panel.

## 6. Balances on mobile: Record opens a sheet (P10)

- "Record" on a suggestion opens a `Sheet` with the form pre-filled
  (payer, payee, amount). Desktop keeps the side-panel form.
- The sheet has `role="dialog"` and `aria-modal`. Focus moves to Amount
  when it opens. Escape or tapping the scrim closes it, and focus returns
  to the Record button.
- While submitting, the Record button shows a busy label.

## 7. Profile and password (D3; no account deletion)

```
Profile                              Login
┌──────────────────────────────┐     ┌──────────────────────────┐
│ Display name [Priya Raman ]  │     │ Email / Password         │
│              [Save]          │     │ [Sign in]                │
│ Email  priya@… (read-only)   │     │ Forgot password?         │
│ Password  [Change password]  │     └──────────────────────────┘
│ [Sign out]                   │     Forgot → "If an account exists for
└──────────────────────────────┘     that email, we've sent a reset link."
```

- **Forgot password:** the sent-state copy is identical whether or not
  the account exists (anti-enumeration).
- **Reset page:** "Set a new password" with the same rules as sign-up.
  Success returns to sign in with a notice.
- **Change password:** the form shape follows what Supabase Auth requires
  (whether re-authentication is needed). Engineering confirms this on
  SplitChat-Dev.
- **Errors and success:** inline validation near each field; success is
  a `Notice`.

## 8. Group settings (D4)

- **Owner:** name and description form with inline validation matching
  the RPC. Save shows a success `Notice`.
- **Member:** the same information as plain text, with no disabled
  inputs.

## Representative slice (designer recommendation, adopted)

**Scope:**

- Tokens in `:root`. `App.css`, `ui.module.css` and
  `GroupWorkspace.module.css` switch to them, plus the corrective fixes
  (focus ring, confirm contrast).
- `BottomNav` and the compact top bar (D1).
- Group tabs reduced to Overview · Expenses · Balances · Chat, with a
  `Menu` for Members / Activity / Settings (D2). Settings is a read-only
  stub until the D4 RPC lands.
- Mobile chat header compaction (P3).

**Not in the slice:** P4–P6 data work, the P10 sheet, profile/password,
and the D4 RPC.

**Acceptance checks** (rendered review on Dev plus tests):

- At 390 px: four bottom items, none clipped. No page overflow and no
  panel spill.
- Top bar ≈ 52 px, with no tagline.
- Four group tabs, none clipped.
- `/groups/:id/members` and `/groups/:id/activity` load when opened
  directly.
- The menu is keyboard operable, and every touched file uses the single
  focus treatment.
- The mobile chat message area is visibly taller than the
  `flat-chat-mobile.png` baseline.
- The contrast pairs above hold. There is no motion under
  `prefers-reduced-motion`.
- The a11y audit reports 0 findings.
