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

# Frontend Engineering Standards

## User Experience

Every meaningful user flow should consider:

- loading state
- success state
- empty state
- error state
- validation state

---

## Accessibility

Use semantic HTML rather than re-implementing native behaviour (buttons,
links, form controls) with generic elements.

For user-facing production UI, meet WCAG 2.1 AA as the baseline:
keyboard operability, visible focus states, labeled inputs and controls,
sufficient color contrast, and screen-reader-accessible names for
interactive elements.

Internal/admin tooling may use a lighter bar, but must still be keyboard
operable and must not rely on color alone to convey meaning.

---

## Components

Prefer reusable components when reuse is meaningful.

Avoid creating abstractions for components that will only ever be used once
unless there is a clear architectural reason.

---

## State

Keep state as local as practical.

Do not introduce global state merely because it is available.

---

## API Interaction

Handle:

- loading
- success
- failure
- timeout/unavailable states
- unexpected responses

Never assume an API call succeeds.

---

## Security

Never put secrets or privileged credentials into client-side code.

Frontend authorization checks must never be treated as the only
authorization mechanism.