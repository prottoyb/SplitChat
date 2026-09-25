---
name: ui-polish
description: This skill should be used when the user asks to redesign the UI, polish the interface, improve UX, modernize the frontend, make the application look professional, improve dashboard presentation, perform a UI/UX audit, or improve product feel.
---

# UI Polish

## Purpose

Workflow for improving the visual/UX quality of an existing interface
without breaking functionality. Builds on `CLAUDE.md`'s Risk Tiers and
`.claude/rules/ui-design.md`.

## When to Use / Not Use

Use for interface redesign, UX polish, visual modernization, or a UI/UX
audit. Not for building new functionality (`/feature-development`) or a
pure security review (`/project-security-review`).

## Preconditions

The affected screens/flows, and any functionality that must remain
stable, are identifiable.

## Procedure

A. **Discovery.** The coordinator (main session, or `engineering-lead`
   for large multi-surface work) identifies affected screens, flows,
   constraints, and functionality that must not change.
B. **Design audit.** Delegate to `ui-ux-product-designer`. It inspects
   the actual existing interface/code and returns an implementable
   specification per its own output contract.
C. **Implementation.** The coordinator implements directly; use
   `fullstack-engineer` only when the change is large/isolated enough to
   justify a separate context. Preserve existing APIs, authentication,
   RBAC, business rules, database/persistence behaviour, and passing
   tests unless a change to one of these is separately authorized.
D. **Design review.** Return to `ui-ux-product-designer` (resume the
   same context when supported) with the diff and rendered
   output/screenshots when available.
E. **One correction pass.** Implement justified corrections. A second
   review cycle requires a material, unresolved usability/accessibility
   problem — not subjective preference.
F. **Engineering verification.** Apply `CLAUDE.md`'s Risk Tiers: UI-only
   work is normally STANDARD; if it touches Sensitive Functionality
   (`.claude/rules/security.md`) it becomes SENSITIVE. Involve
   `software-architect` only if an actual architecture trigger applies.
G. **Final review.** `senior-reviewer` performs the normal independent
   engineering review for significant work; it does not repeat the
   visual-design audit, and the designer does not replace it.

## Required Verification

The risk tier's requirements from `CLAUDE.md`'s Merge Readiness Gate,
plus confirmation that existing tests still pass.

## Failure Conditions

Same as `/feature-development`: an unresolved CRITICAL/HIGH finding
blocks merge; a missing required approval stops only the gated step.

## Human Approval Requirements

Standard Merge Readiness Gate approvals (`CLAUDE.md`). No approval this
skill can grant on its own.

## Interaction with Other Skills

Design-only requests without implementation may stop after step B.
Requests to add new functionality belong in `/feature-development`
instead.

## Completion Criteria

Merge Readiness Gate satisfied; design review found no unresolved
material issue beyond subjective preference; existing protected
behaviour verified unchanged.
