# Phase 9 — design system

Author: UI/UX Product Designer (spec), coordinator (contrast measured,
corrections marked "Coord."). Applies from Increment 0. Tokens are CSS
custom properties on `:root` in `src/index.css`. Feature CSS Modules use
`var(--token)` and do not use raw hex, px radii or font sizes where a
token exists.

Principle: tokenising is a **same-value rename** except where a row below
says "visible change". Every visible change is listed here and shown in
the review screenshots.

## 1. Colour

Contrast figures are WCAG 2.1 ratios computed from sRGB luminance (Coord.:
measured, not estimated). AA requires ≥ 4.5 for normal text and ≥ 3 for
non-text UI.

### Surfaces and borders

| Token | Value | Replaces |
|---|---|---|
| `--surface-page` | `#f6f7f9` | page background |
| `--surface-card` | `#ffffff` | cards, panels, inputs |
| `--surface-subtle` | `#f2f4f7` | icon chips, subtle fills (`#eff0f3`, `#f1f5f9`, `#f5f6f8`, `#f2f3f6`, `#f8fafc`). Visible change: `#f1f5f9` → slightly warmer, negligible |
| `--border-default` | `#e7e9ed` | card/panel borders (`#e4e6eb`, `#dfe1e7`, `#e0e2e7`, `#eceef2`, `#e2e8f0`) |
| `--border-strong` | `#cbd5e1` | stronger dividers on light surfaces |

### Text on light surfaces

| Token | Value | Contrast | Replaces |
|---|---|---|---|
| `--text-primary` | `#1c1e26` | 16.6 on white | near-black text (`#111827`, `#0f172a` *as text*, `#22242c`, `#20222a`, `#1d1f27`, `#18202a`, `#2b2f38`, `#383b46`) |
| `--text-secondary` | `#5f6470` | 5.93 on white, 5.53 on page, 5.38 on subtle | secondary greys (`#6b707c`, `#677180`, `#6a6d76`, `#617187` …) |
| `--text-on-brand` | `#ffffff` | 6.41 on brand-600, 6.10 on danger-bg, 16.6 on primary | text on filled buttons |

**No lighter tertiary text colour.** The Phase 8 register asked for a
two-step secondary/tertiary scale. The designer rejects a lighter grey
because `#94a3b8` is 2.56 on white and fails AA. Hierarchy below
secondary comes from size and weight (`--text-xs`), not a lighter colour.
This closes the Phase 8 deferred item.

Corrective fix: `.confirmBox p` `#836a6a` (4.73 on `#fff8f8`, borderline)
becomes `--text-secondary` (5.65).

### Brand / accent

| Token | Value | Contrast | Use |
|---|---|---|---|
| `--brand-700` | `#4f3bb8` | 7.92 | hover/active, info text |
| `--brand-600` | `#5b41e0` | 6.41 on white, 5.57 on subtle bg | default accent: buttons, links, icons |
| `--brand-500` | `#7054f6` | 4.90 | focus ring, spinners, decoration |
| `--brand-subtle-bg` | `#f0edff` | | chips, selected rows (`#efecff`, `#f1efff`, `#f5f3ff`) |
| `--brand-subtle-bg-hover` | `#f6f4ff` | | hover fills (`#faf9ff`) |
| `--brand-subtle-border` | `#dcd6ff` | | accent borders (`#cfc6ff`) |

Mapping: `#6549ed`, `#6d51ef`, `#654bea`, `#6750d8` become `--brand-600`;
`#7357ff` becomes `--brand-500`. Visible change: a hair on some links and
buttons.

### Focus

`--focus-ring: 2px solid var(--brand-500)`, `outline-offset: 2px`
(`-2px` inside filled or dark controls).

Visible, corrective change: the box-shadow rings in Groups, Auth and
ExpenseForm, including a grey one, become this outline, so there is one
focus treatment everywhere. Outlines are not clipped by `overflow: hidden`.

### Dark shell (sidebar, mobile top bar)

| Token | Value | Contrast |
|---|---|---|
| `--shell-bg` | `#111827` | |
| `--shell-text-secondary` | `#94a3b8` | 6.92 on shell |
| `--shell-text-link` | `#cbd5e1` | 11.95 on shell |
| `--shell-border-subtle` | `rgba(255,255,255,.08)` | |
| `--shell-hover-bg` | `rgba(255,255,255,.06)` | |
| `--shell-active-bg` / `--shell-active-text` | `#ffffff` / `#111827` | |

Coord.: `#0f172a` is used only as **text** in
`ExpenseForm.module.css`, so it becomes `--text-primary`, not the shell.

### Status

| Token | Value | Contrast |
|---|---|---|
| `--success-fg` / `-border` / `-subtle-bg` | `#297149` / `#cde7d7` / `#f1faf5` | 5.91 white, 5.55 subtle |
| `--danger-fg` / `-border` / `-subtle-bg` | `#a13f3f` / `#e7caca` / `#fff4f4` | 6.37 white, 5.91 subtle |
| `--danger-bg` / `-bg-hover` | `#aa3d3d` / `#913232` | white text 6.10 |
| `--warning-fg` / `-border` / `-subtle-bg` | `#92400e` / `#fde68a` / `#fef3c7` | **new**; 6.37 on subtle; for pending badges (P4/P5) |

Mapping: `#a33d3d`, `#8d3434` become `--danger-fg`; `#efd0d0`, `#edd0d0`
become `--danger-border`; `#fff1f1`, `#fff5f5`, `#fff8f8` become
`--danger-subtle-bg`; `#237044` becomes `--success-fg`.

## 2. Radius

`--radius-sm: 8px` (chips, tags, small icon boxes) · `--radius-md: 12px`
(default: buttons, inputs, cards, rows) · `--radius-lg: 16px` (panels,
banners, sheets) · `--radius-pill: 999px` · `--radius-circle: 50%`.

- **7px** becomes sm. **11px** and **13px** become md.
- **14px** becomes md on small elements and lg on panel-scale elements.
  Judge each use by element size.
- **9px/10px** buttons become md. Visible change: slightly rounder
  buttons.
- **18px** becomes lg. Visible change: the ExpenseForm cards, the Expense
  details / Expenses page panels, and the Members / Groups page cards get
  slightly tighter corners.

## 3. Spacing

A 4 px base: `--space-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 · `-6`
24 · `-7` 32 · `-8` 40 · `-9` 48.

This describes values already in use. Round ad hoc values to the nearest
step in files that are being touched anyway; do not sweep the whole
codebase.

## 4. Type scale

| Token | Size / line-height | Use |
|---|---|---|
| `--text-xs` | 12 / 1.4 | eyebrows, meta, badges |
| `--text-sm` | 13 / 1.5 | secondary body, buttons, links |
| `--text-base` | 14 / 1.55 | reading copy |
| `--text-md` | 16 / 1.4 | card values, sub-headings (was 15–17) |
| `--text-lg` | 20 / 1.25 | section headings (was 18–22) |
| `--text-xl` | 24 / 1.2 | stat numbers (was 24–26) |
| `--text-2xl` | 30 / 1.15 | page titles (was 28–32) |
| `--text-hero` | `clamp(2.375rem, 4vw, 3.625rem)` | auth hero **only** |

Icon glyph sizing (a font-size used to size an icon in a fixed box) is
not type and stays local. When a file is touched, classify each 12/13/14
use as meta (`xs`) or reading copy (`base`) rather than keeping the
accidental split.

## 5. Elevation

`--shadow-sm: 0 1px 2px rgba(17,24,39,.05)` (resting cards) ·
`--shadow-md: 0 8px 28px rgba(21,25,38,.06)` (menus, sheets, hover) ·
`--shadow-lg: 0 4px 14px rgba(17,24,39,.2)` (floating over content).

One documented exception: the tinted auth CTA shadow
(`--shadow-brand-cta`).

## 6. Shared components (lean; only what the approved plan needs)

| Component | Props | Replaces / used by |
|---|---|---|
| `StatCard` | `icon, label, value, tone?, hint?` | `summary-card` variants (dashboard, overview) |
| `PositionChip` | `amountCents, variant: 'chip' \| 'inline'` | every "you owe / you're owed / settled up". Always colour **and** words (built on `balanceTone` / `positionText`) |
| `ListRow` | `leading, title, meta?, trailing?, href? / onClick?` | expense, activity, member and group rows |
| `Panel` | `eyebrow?, title, description?, actions?, children` | ad hoc panel headers (builds on `SectionHeader`) |
| `TabBar` | `items: {label, to, badge?}[]` | group workspace tabs (Chat badge, P4) |
| `BottomNav` | `items: {label, icon, to}[]` | mobile app shell (D1), ≤ 720 px |
| `Sheet` | `open, onClose, title, children` | mobile Record payment (P10). `role="dialog"`, `aria-modal`, focus trap, Escape and scrim close, focus returns to the trigger, no motion under reduced motion |
| `Menu` | `trigger, items: {label, to? / onClick?, tone?}[]` | group menu (D2). Disclosure menu: Enter/Space opens, arrows move, Home/End, Escape closes and returns focus, Tab closes |

Reuse the existing `LoadingState`, `ErrorState`, `Notice`,
`InlineConfirm`, `SectionHeader` and `Avatar` (`src/shared/ui`).
