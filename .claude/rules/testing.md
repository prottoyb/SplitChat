# Testing Standards

Testing is part of implementation, not a separate activity performed
only at the end.

---

## Test Meaningful Behaviour

Tests should verify behaviour rather than implementation details.
Asserting on an implementation detail directly is only justified when
that detail is itself part of the contract (e.g., a public API's exact
response shape, a wire format, a persisted schema).

---

## Test Categories

Use the appropriate level of testing:

- unit tests
- integration tests
- API tests
- database tests
- component tests
- end-to-end tests

Do not create every type of test for every feature unnecessarily. Match
the level to where a fault would actually be caught: unit tests for
isolated logic, integration/API/database tests for boundaries between
components, component/end-to-end tests for critical user journeys.

---

## Happy Path

Test expected successful behaviour.

---

## Failure Cases

Test the following whenever the code path is reachable by untrusted
input, or affects authentication, authorization, payment, or data
integrity:

- invalid input
- unauthorized access
- missing data
- network failures
- database failures
- unavailable dependencies
- boundary conditions

---

## Regression

When fixing a meaningful bug, add a regression test.

A regression test may be omitted only when it genuinely cannot be
created (e.g., it would require reproducing external infrastructure
state that cannot be simulated) or the behaviour is already covered by
an existing test. The implementing agent may not decide this alone:

1. The implementing agent documents the specific technical reason a
   test cannot be created.
2. QA/Security or Senior Review independently confirms the
   justification is genuine and not a matter of convenience.
3. Explicit human approval (`CLAUDE.md`'s Human Approval) is recorded
   before the change merges without the regression test.

This is Mandatory Gate #4 (`CLAUDE.md`).

---

## Existing Tests

Do not delete or weaken an existing test simply because the implementation
now fails it.

Determine whether:

1. the implementation is wrong
2. the test is outdated
3. the requirement changed

Then make the appropriate decision.

---

## Completion

A feature is not considered verified until applicable tests pass.

Agents must report:

- tests executed
- tests passed
- tests failed
- known coverage gaps