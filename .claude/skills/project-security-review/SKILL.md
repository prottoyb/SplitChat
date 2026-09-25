---
name: project-security-review
description: This skill should be used when the user asks to "run a project security review", "check this for vulnerabilities against our security rules", "review this against .claude/rules/security.md", or when a change touches authentication, authorization, input handling, secrets, dependencies, or other sensitive functionality and needs review against this project's own security rules and Mandatory Gates.
---

# Project Security Review

## Purpose

Independent security review against this project's own
`.claude/rules/security.md` and Mandatory Gates, performed by
`qa-security` independently of whoever implemented the change. Distinct
from any bundled Claude Code security-review capability — this skill is
scoped specifically to this project's `.claude/rules/` and `CLAUDE.md`.

## Invocation Policy

Model-invocable by design: the coordinator must be able to run this
review itself whenever the risk tier requires it (SENSITIVE work,
including HIGH-RISK / ARCHITECTURAL work that is also sensitive, as
defined in `CLAUDE.md`), without waiting for a human to type the
command. That is safe because the skill only *analyses*: it changes no
code, executes nothing gated, and grants no approval. Every gated action
(merge, irreversible action, dependency/test/governance exception) still
needs its own human approval. Do not restore `disable-model-invocation`
— it would make the tier requirement impossible to follow.

## Who Does What

The coordinator (main session) assembles a work packet — diff, risk tier,
relevant rules, output contract — and delegates the review to the
`qa-security` subagent, which applies the procedure below. The
coordinator does not perform the review itself when it also wrote the
change.

## When to Use

A change meets `.claude/rules/security.md`'s Sensitive Functionality
criteria (SENSITIVE work, including HIGH-RISK / ARCHITECTURAL work that
is also sensitive — `CLAUDE.md`); a human explicitly
requests it; a security-relevant exception needs independent
verification — including a Mandatory Gate #3 dependency-exception package
being prepared (`.claude/rules/security.md`, Preparing an exception).
When in doubt, use it — the cost of an unnecessary review
is lower than a missed one.

## When Not to Use

No plausible sensitive-functionality trigger, and only general
code-quality review is needed — that's `senior-reviewer`'s ordinary
review (running both is fine).

## Preconditions

A concrete diff exists. The reviewer is a separate context/subagent from
the implementer wherever the tooling supports it — procedurally, not
mechanically, enforced; treat it as a hard requirement regardless.

## Required Rule Context

`.claude/rules/security.md` (full file), `.claude/rules/engineering.md`
§12 (taxonomy + Reviewer Disagreement), `.claude/rules/database.md`'s
Security/Destructive Changes sections if the data layer is involved,
`CLAUDE.md`'s Mandatory Gates and Human Approval.

## Procedure

1. Confirm independence from the implementer.
2. Assess Sensitive Functionality against `.claude/rules/security.md`.
3. Review: authentication, authorization, input validation, injection,
   data isolation, secrets, dependencies, sensitive config, and any
   weakened existing control.
4. If a dependency exception is involved, independently verify the risk
   assessment and compensating control (`.claude/rules/security.md`'s
   Dependencies section) — never accept the implementer's self-assessment
   alone.
5. Rate findings using the canonical taxonomy
   (`.claude/rules/engineering.md` §12) — never a new scale.
6. Any unresolved CRITICAL/HIGH, or another Mandatory Gate (#3
   dependency, #4 test, #5 irreversible action), blocks merge/execution
   — state this plainly and name the specific human approval required.
7. Return PASS/FAIL with severities, each citing the rule violated.

## Failure Conditions

Unresolved CRITICAL/HIGH → FAIL, cannot be overridden by the coordinator
or `engineering-lead`. Independence violated (implementer reviewed
itself) → invalid, redo with a different agent instance. This skill
surfaces which Mandatory Gate approval is required; it never grants one.

## Interaction with Other Skills

Typically invoked from `/feature-development`'s review step, or run
standalone. Disagreement with `senior-reviewer` follows
`.claude/rules/engineering.md`'s Reviewer Disagreement procedure. Record
recurring vulnerability classes to memory; a finding implying a rule
change is a proposal only (Governance Change Control, `CLAUDE.md`).

## Completion Criteria

PASS with no unresolved CRITICAL/HIGH finding, or an explicit
FAIL/blocked state naming the required approval.
