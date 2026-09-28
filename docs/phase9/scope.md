# Phase 9 — scope and decision boundary

**Phase 9 — Product Experience, UX & Functional Refinement.** Approved by
the operator on 2026-09-29 in the live session. This file records that
approval and the scope text the operator adopted as the phase's decision
boundary. Where it and `CLAUDE.md` disagree, `CLAUDE.md`'s Mandatory Gates
win.

## Operator approval (2026-09-29)

- Phase 9 is approved to start. The functional-freedom text below is its
  scope and decision boundary.
- Primary goal: make SplitChat feel like a genuinely useful, polished
  application, not just a technically complete project. UI/UX is the
  main focus.
- The UI/UX Product Designer leads product-experience direction. The
  Engineering Lead coordinates the Architect, Fullstack Engineer,
  QA/Security and Senior Review.
- Branch: `feature/phase9-product-ux` from `main` @ `dfec625`.
- **First deliverable: the UX/product review only**, run against
  SplitChat-Dev (never production). It produces a prioritised
  product/UX proposal in `docs/phase9/plan.md`.
- After the review: major product or information-architecture decisions
  stop for the operator. If the direction is clear and inside the
  autonomy boundary, the team continues into wireframes and design-system
  work. Do not rewrite the whole app in one go.
- Production is at M23 (batch 4 executed and verified by the operator)
  and stays untouched during Phase 9 unless a later explicit approval is
  given. New backend/database work uses new migrations, is tested and
  rehearsed on SplitChat-Dev, and is not applied to production without
  separate approval. **No frontend deployment.**

## Functional freedom

The team may modify existing functionality or introduce new
functionality when the UX/product review shows that doing so materially
improves SplitChat as a real product. This is deliberately broader than a
visual redesign.

Acceptable examples: simplifying or combining existing flows; changing
navigation; more useful group/home actions; shortcuts and contextual
actions; a better settlement flow; better presentation of balances and
what to do about them; better interaction between Smart Expense and
Chat; changing dashboard/home information; useful empty states,
reminders, status indicators and summaries; lightweight features that
remove obvious usability friction; removing or demoting low-value
functionality; changing confusing interaction patterns; small supporting
capabilities needed for a coherent user journey.

The UI/UX Product Designer may propose these. The Engineering Lead,
Architect and Fullstack Engineer assess whether each needs frontend-only
changes, domain-logic changes, backend/API changes, database changes, new
Realtime behaviour, or migration work.

## Decision boundary

**The team may proceed autonomously with:**

- frontend-only functional improvements
- low-risk domain-logic changes
- small UX-driven capability additions
- interaction simplification
- navigation changes
- new non-destructive convenience features
- changes that do not materially alter the product's financial/security
  model

**Stop for human approval before:**

- a major product-scope expansion
- a new core financial concept
- a material change to balance or settlement semantics
- a material change to expense ownership or permissions
- a new role/permission model
- a new external service
- paid infrastructure
- a significant backend architecture change
- a database migration that changes production data semantics
- destructive or irreversible behaviour
- any production write
- deployment

## Backend changes

Backend/database work is permitted when an approved UX/product
improvement genuinely needs it. Do not drop a useful improvement only
because it needs backend work. However:

- design the user experience first;
- justify the backend requirement;
- keep the change minimal;
- preserve security and financial invariants (ADR-0002, ADR-0006,
  ADR-0010);
- create new migrations; never edit a migration already applied to
  production (M0–M23 are all applied);
- rehearse on SplitChat-Dev;
- production stays blocked until a later explicit release approval.

Anything touching auth, group membership, RLS/policies or cross-member
expense visibility remains SENSITIVE (`CLAUDE.md`) and gets
`project-security-review`.

## Product judgment

Actively look for functionality that is confusing, redundant, too
technical, hidden, awkward on mobile, unnecessarily multi-step, or not
useful in real life, and propose better alternatives. No existing
feature or screen is guaranteed to survive unchanged. Avoid feature
creep: every new or changed capability must answer **"What real user
problem does this solve?"** If there is no clear answer, do not build it.
