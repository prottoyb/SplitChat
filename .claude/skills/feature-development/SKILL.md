---
name: feature-development
description: This skill should be used when the user asks to "implement a feature", "build this functionality", "add support for X", or requests any new capability or behavior change that goes beyond a trivial local edit.
---

# Feature Development

## Purpose

Workflow for implementing significant software work end-to-end, from
requirement to merge-ready, using `CLAUDE.md`'s Risk Tiers. Scoped
exactly to `CLAUDE.md`'s significant-work definition (Development
Lifecycle section) — trivial or local edits don't need this skill.

## When to Use

New functionality, a behavior change, or a capability another user or
system will depend on, meeting `CLAUDE.md`'s significant-work criteria.

## When Not to Use

Not significant → handle directly in the main session. Pure security
review → `/project-security-review`. Post-work learning capture →
`/retrospective`. UI-only polish with no new functionality →
`/ui-polish`.

## Required Rule Context

`.claude/rules/engineering.md`, `.claude/rules/testing.md`,
`.claude/rules/git.md`, `.claude/rules/documentation.md` (ADR triggers),
`.claude/rules/security.md`'s Sensitive Functionality section, and
whichever of `frontend.md`/`backend.md`/`database.md`/`ui-design.md`
cover the layers touched. `CLAUDE.md`'s Development Lifecycle, Risk
Tiers, Merge Readiness Gate, Mandatory Gates, Human Approval.

## Procedure

1. **Confirm scope** is significant; if not, stop and handle it
   directly.
2. **Inspect the repository** per `.claude/rules/engineering.md` §1.
3. **Determine the risk tier** (`CLAUDE.md`). If HIGH-RISK/ARCHITECTURAL,
   involve `software-architect` and produce an ADR when a trigger is
   met; when genuinely ambiguous, default to involving it.
4. **Plan** — break into tasks; decide whether `fullstack-engineer` is
   warranted (implementation large/isolated enough for a separate
   context) or the main session implements directly; decide whether
   `ui-ux-product-designer` is warranted (meaningful new UI, not just
   polish — otherwise use `/ui-polish`).
5. **Implement** per the applicable rule files.
6. **Test** per `.claude/rules/testing.md`.
7. **Review** per the risk tier. SENSITIVE work (including HIGH-RISK
   work that is also sensitive) runs the `/project-security-review`
   Skill; that Skill delegates the independent review to `qa-security`.
   Delegating to `qa-security` without the Skill does not satisfy this
   step. Every tier also requires independent `senior-reviewer`.
8. **Verify** against `CLAUDE.md`'s Merge Readiness Gate.
9. **Confirm required human approvals** are recorded.
10. **Merge** only once the Gate is fully satisfied.

## Failure Conditions

Unresolved CRITICAL/HIGH → stop; do not merge (Reviewer Disagreement
procedure in `.claude/rules/engineering.md` if reviewers differ). A
missing required test → the exception process in
`.claude/rules/testing.md`, never a unilateral skip. A missing required
approval → stop the gated step per `CLAUDE.md`'s Human Approval section
("Silence is not approval"); continue other ungated work.

## Required Evidence

The selected risk tier (`CLAUDE.md`), the trigger(s) that caused it, and
any combined classification (e.g. HIGH-RISK / ARCHITECTURAL + SENSITIVE);
task breakdown, test results, review findings (with severities), any
ADR, any approval records, a PR description (what/why/how tested,
limitations, security considerations).

## Learning Opportunities

Record project-specific lessons to memory directly. A lesson implying a
governance change is a proposal only — human approval required
(`CLAUDE.md`'s Governance Change Control).

## Completion Criteria

Merge Readiness Gate fully satisfied; required approvals recorded;
evidence captured.
