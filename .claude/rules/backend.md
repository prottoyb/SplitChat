---
paths:
  - "backend/**"
  - "server/**"
  - "api/**"
  - "src/api/**"
  - "src/lib/**"
  - "src/server/**"
---

# Backend Engineering Standards

## API Design

APIs should have:

- predictable naming
- appropriate HTTP semantics
- validation
- structured errors
- authentication where required
- authorization where required

---

## API Versioning and Breaking Changes

A change is breaking if it removes or renames a field/endpoint, changes a
field's type or meaning, tightens validation in a way existing clients
would fail, or changes authentication/authorization requirements for
existing callers.

A breaking change to an API with external or cross-team consumers
requires either a new version, a documented deprecation window, or
explicit coordination with those consumers before the old behaviour is
removed.

An API with no consumers outside the change itself may change freely.

---

## Business Logic

Business rules should live in an appropriate backend/domain layer.

Do not rely on frontend logic to enforce business rules.

---

## Error Handling

Return safe, useful errors.

Do not expose:

- stack traces
- database internals
- secrets
- unnecessary implementation details

---

## Validation

Validate external input before processing it.

Never assume clients are trustworthy.

---

## Authentication and Authorization

Every protected operation must independently verify authorization.

Do not assume that because a route requires authentication,
the user is allowed to perform every operation on that route.

---

## Logging

Logs should help diagnose problems without exposing sensitive data.

Never log:

- passwords
- access tokens
- secrets
- sensitive personal data unnecessarily

---

## Observability

A service should expose enough signal to diagnose problems without
reading its source in production:

- structured, leveled logs for significant events and errors
- a health/readiness check for anything deployed as a long-running
  service
- a correlation/request identifier propagated through a request where
  the stack makes this practical

Apply this in proportion to what is actually deployed — a script or
library invoked in-process does not need a health endpoint.