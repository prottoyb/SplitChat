# Engineering Standards

## Purpose

These rules define the minimum engineering standard for all software
developed by the AI Software Engineering Team.

---

## 1. Understand Before Changing

Before modifying code:

- inspect the relevant repository structure
- read the relevant existing implementation
- understand dependencies
- identify existing patterns
- check relevant documentation
- check existing tests

Do not make assumptions about code that can be inspected.

---

## 2. Prefer Simplicity

Prefer:

- simple architecture
- clear boundaries
- understandable code
- small functions
- focused modules
- established patterns

Avoid:

- unnecessary abstractions
- premature optimization
- unnecessary services
- unnecessary dependencies
- clever code that is difficult to maintain

---

## 3. Preserve Existing Behaviour

Before changing existing functionality:

1. Understand current behaviour.
2. Identify dependencies.
3. Determine whether existing tests cover it.
4. Consider backward compatibility.

Do not break existing functionality to implement unrelated features.

---

## 4. Reuse Before Creating

Before creating a new:

- component
- utility
- service
- API
- database function
- validation mechanism
- dependency

check whether an appropriate existing implementation already exists.

---

## 5. Handle Failure Properly

Production software must handle failure.

Consider:

- invalid input
- network failures
- database failures
- authentication failures
- authorization failures
- unavailable services
- unexpected responses
- empty states
- concurrency issues, whenever more than one process or request can act
  on the same data at the same time (see `.claude/rules/database.md`
  for transactional/concurrency guidance)

Do not assume the happy path is sufficient.

---

## 6. Never Hide Problems

Agents must not:

- suppress errors
- remove tests because they fail
- disable validation to make functionality work
- weaken security controls
- ignore build failures
- claim success without verification

If something cannot be completed, report it clearly.

---

## 7. Dependency Discipline

Before adding a dependency:

- determine whether existing functionality can solve the problem
- assess maintenance status
- assess security implications
- consider bundle/runtime impact
- consider whether the dependency is justified

Do not add dependencies merely for convenience.

Dependency security scanning requirements and the handling of known
vulnerabilities are defined in `.claude/rules/security.md`; apply them
before adding or upgrading a dependency.

---

## 8. Code Quality

Code should be:

- readable
- maintainable
- appropriately modular
- consistently named
- appropriately typed
- tested where meaningful

Avoid both:

- giant functions/classes
- unnecessary fragmentation

---

## 9. Root Cause

When fixing a bug:

Do not only fix the visible symptom.

Determine:

1. What failed?
2. Why did it fail?
3. Why was the failure possible?
4. What prevents the same failure happening again?

Add a regression test per the criteria in `.claude/rules/testing.md`.

---

## 10. Verification

Never claim a task is complete without performing applicable verification.

Examples:

- tests
- lint
- type checking
- build
- integration tests
- security checks

Report exactly what was verified.

---

## 11. Build, Deployment and Environments

Configuration must be environment-specific and externalized (environment
variables or a secret manager), never hardcoded per environment in
source.

Keep development, staging and production configuration separated so a
change in one cannot silently affect another.

CI checks (type checking, lint, tests, build) must pass before a change
is merged. Do not merge with a known-failing check.

Do not make undocumented manual changes directly against a deployed
environment; a change to a running environment should be reproducible
from the repository (code, migration, or configuration change). This is
the canonical statement of the production-change control; database
schema changes follow it via `.claude/rules/database.md`'s Migrations
section rather than restating it.

Apply this section using whatever CI/CD and environment tooling the
project actually uses — the requirement is the outcome (reproducible,
environment-separated, gate-checked changes), not a specific tool.

---

## 12. Severity Taxonomy and Merge Readiness

All review, QA, and security findings use this taxonomy. This is the
single canonical definition — an agent must not define its own scale.

- **CRITICAL** — an exploitable security vulnerability, a data
  loss/corruption risk, a break in authentication/authorization, or a
  violation of a Mandatory Gate (`CLAUDE.md`). Blocks merge
  unconditionally.
- **HIGH** — a significant correctness, security, or reliability defect
  that is not immediately exploitable but is likely to cause
  user-facing harm, data issues, or a production incident. Blocks merge
  unconditionally.
- **MEDIUM** — a meaningful quality, maintainability, or
  minor-correctness issue. Should be fixed before merge; may be deferred
  to a documented, tracked follow-up only when no CRITICAL or HIGH
  finding exists on the same change.
- **LOW** — cosmetic or stylistic. Does not block merge.
- **OPTIONAL** — a suggestion. Does not block merge.

### Reviewer Disagreement

QA/Security and Senior Review are independent. Neither may override the
other, and the coordinator (the main session, or `engineering-lead` when
invoked) may not override either:

- If they rate the same underlying issue differently, the higher
  severity governs for merge-gate purposes.
- If they reach a different conclusion about something other than
  severity (e.g., whether a design is acceptable), the coordinator may
  arrange further investigation or ask either reviewer to reconsider,
  but may not decide the disagreement itself. Resolution requires one
  reviewer to change position after reconsideration, or explicit human
  adjudication.

The full merge-readiness checklist is defined in `CLAUDE.md`'s Merge
Readiness Gate.