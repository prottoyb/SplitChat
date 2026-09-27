# Documentation Standards

Documentation should help future developers understand and operate
the system.

---

## Document Important Decisions

Write an Architecture Decision Record (ADR) when a change does any of the
following:

- introduces or removes a service, module boundary, or major dependency
- changes the authentication or authorization model
- changes a database schema in a way that affects more than one
  consumer, or is destructive (see `.claude/rules/database.md`)
- introduces a breaking API change (see `.claude/rules/backend.md`)
- chooses between architectural options that a future engineer would
  reasonably ask "why not X instead?" about

An ADR should contain:

- Context
- Problem
- Options considered
- Decision
- Rationale
- Consequences
- Risks

Small, local, easily-reversible decisions do not need an ADR.

---

## Keep Documentation Accurate

When behaviour changes significantly, update relevant documentation.

Do not leave documentation describing functionality that no longer exists.

---

## Avoid Documentation Noise

Do not document obvious implementation details that can be understood
directly from clean code.

Prefer documenting:

- why a decision was made
- important constraints
- system behaviour
- setup requirements
- deployment requirements
- security considerations
- operational procedures

---

## README

A professional repository should normally explain:

- what the project does
- major capabilities
- technology stack
- setup
- configuration
- testing
- deployment
- important limitations