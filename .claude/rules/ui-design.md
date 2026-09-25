---
paths:
  - "frontend/**"
  - "client/**"
  - "web/**"
  - "src/components/**"
  - "src/pages/**"
  - "src/layouts/**"
  - "src/auth/**"
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/*.vue"
  - "**/*.svelte"
  - "**/*.css"
  - "**/*.scss"
---

# UI/UX Design Standards

Reusable visual and interaction design principles. Applies to
user-facing frontend work; internal/admin tooling may use a lighter bar
per `.claude/rules/frontend.md`'s Accessibility section, but the
principles below still apply.

---

## Visual Hierarchy and Layout

- One clear primary action per view or section.
- A consistent spacing scale (e.g. 4/8px increments) — no ad hoc
  spacing.
- A small, fixed typography scale (sizes/weights), applied consistently.
- Predictable layout: consistent structure and density across similar
  screens; avoid page-specific visual drift.

---

## Responsive and Accessible

- Verify layouts at common breakpoints (mobile, tablet, desktop).
- Meet `.claude/rules/frontend.md`'s WCAG 2.1 AA baseline: contrast,
  visible focus states, keyboard operability, semantic interaction.
- Never convey status or priority by color alone — pair with text or an
  icon.
- Respect `prefers-reduced-motion`; keep motion purposeful and brief.

---

## Component Consistency

- Reuse existing design-system components/tokens before introducing new
  ones (`.claude/rules/engineering.md`'s Reuse Before Creating).
- Tables: sortable/filterable where meaningful; sensible loading, empty
  and error states; avoid unnecessary horizontal scroll.
- Forms: inline validation near the field; clear required/optional
  marking; explain disabled states.
- Charts: label axes/units; avoid chartjunk; pick the chart type that
  matches the comparison being made.

---

## States

Every meaningful view needs: a loading state (a skeleton, not a blank
screen), an empty state (explains why, with a next action), an error
state (actionable, not just "something went wrong"), and success
feedback (a toast or inline confirmation, not silence).

---

## Choosing a Surface

- **Page** — a distinct, navigable destination or a multi-step flow.
- **Modal** — a focused, blocking task that briefly interrupts context.
- **Drawer** — supplementary detail or editing alongside current context.
- **Popover/menu** — a small set of contextual actions, or a short
  glance at more detail.

---

## Avoid

Decorative clutter with no functional purpose; gratuitous animation;
inventing a new visual pattern where an existing one already solves the
problem.
