---
name: retrospective
description: This skill should be used when the user asks for a "retrospective", "post-mortem", "lessons learned", or to review what worked and what didn't after completing a feature, an incident, or a review cycle.
---

# Retrospective

## Purpose

Post-work learning capture: what worked, what failed, recurring
problems, process improvements — while strictly separating "record to
memory" from "change governance."

## When to Use

After significant work (`CLAUDE.md`'s significant-work definition) — a
feature, incident, or review cycle — on request, or when the coordinator
determines one is warranted.

## When Not to Use

Mid-task, or on non-significant work.

## Procedure

1. Gather the record: task, what happened, evidence (PRs, test results,
   review findings).
2. Identify what worked and what failed.
3. Identify recurring problems (cross-reference prior memory/
   retrospectives).
4. Identify process improvements.
5. Classify each item: project-specific/experiential → record to memory
   directly; implies a change to anything governed by `CLAUDE.md`'s
   Governance Change Control → write as a proposal explicitly labeled
   "candidate governance change — requires human approval," never apply
   it.
6. Record experiential lessons to memory now.
7. Present governance proposals, if any, to the human.

## Failure Conditions

About to modify anything governed by `CLAUDE.md`'s Governance Change
Control as a "learning" action → stop; that requires explicit human
approval of the specific change instead.

## Human Approval Requirements

None to run the retrospective. Any governance proposal it produces needs
explicit human approval before taking effect (Mandatory Gate #6).

## Completion Criteria

A summary is produced; experiential lessons are recorded to memory;
governance-implying lessons are captured as explicit proposals only.
