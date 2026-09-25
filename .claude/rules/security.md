# Security Standards

Security is a mandatory engineering concern.

---

## Sensitive Functionality

Functionality is sensitive — and requires the security review this file
describes — whenever it does any of:

- handles authentication, authorization, or session management
- reads or writes another user's data, or crosses a tenant/ownership
  boundary
- handles payment, billing, or financial data
- stores, transmits, or displays personal or confidential data
- accepts external/untrusted input that reaches a database, filesystem,
  shell, or another service
- manages secrets, credentials, or access-control configuration
- performs an action listed in Irreversible and High-Risk Actions, below

When in doubt, treat the functionality as sensitive: the cost of an
unnecessary review is much lower than the cost of a missed one.

---

## Secrets

Never place secrets in:

- source code
- Git history
- frontend bundles
- public configuration
- README files
- screenshots
- logs

Use appropriate environment variables or secret-management mechanisms.

Never commit `.env` files containing real credentials.

Secrets and credentials must be rotated on a reasonable schedule and
immediately after any suspected exposure (committed by mistake, leaked in
logs, shared insecurely, or a departing team member/service had access).
Prefer credentials that are short-lived or automatically rotated by the
platform (e.g., short-lived tokens, managed identities) over long-lived
static secrets wherever the platform supports it.

---

## Authentication

Authentication determines who a user is.

Do not assume authentication means the user is authorized to perform
an action.

---

## Authorization

Every protected operation must verify that the authenticated user
has permission to perform that operation.

Do not rely solely on frontend checks.

---

## Input Validation

Treat all external input as untrusted.

Validate:

- request parameters
- request bodies
- query parameters
- uploaded files
- external API responses
- user-generated content

---

## Data Access

Users must only be able to access data they are authorized to access.

Consider:

- ownership
- roles
- group membership
- tenant boundaries
- database-level protections

---

## Injection

Protect against relevant injection vulnerabilities, including:

- SQL injection
- command injection
- XSS
- template injection
- unsafe deserialization

Use established framework mechanisms and parameterized queries.

---

## Sensitive Data

Do not expose unnecessary:

- personal information
- credentials
- tokens
- internal identifiers
- administrative data

Return only the data required by the client.

---

## Dependencies

Run dependency/security scanning appropriate to the project's ecosystem
(e.g., `npm audit`, `pip-audit`, `cargo audit`, GitHub Dependabot alerts,
or an equivalent) before merging a change that adds or upgrades a
dependency.

A dependency with a known vulnerability is never acceptable merely
because an agent documents why it was used, and never acceptable on the
implementing agent's own say-so. Introducing or keeping such a
dependency requires **all** of the following:

1. Investigation of non-vulnerable alternatives (a fixed version, a
   different package, vendoring only the needed piece, or removing the
   need for the dependency) — documented even when none is viable.
2. A documented, specific risk assessment: what the vulnerability allows
   and whether it is actually reachable in this context.
3. An appropriate compensating control that mitigates the specific
   vulnerability (e.g., the vulnerable code path is unreachable, network
   access to the affected component is restricted, input reaching it is
   never attacker-controlled).
4. Independent verification of the risk assessment and the compensating
   control by QA/Security (`.claude/agents/qa-security.md`) — the
   implementing agent cannot verify its own exception.
5. Explicit human approval of the exception (`CLAUDE.md`'s Human
   Approval).

All five are required — documentation alone, or a self-assessed
compensating control alone, is never sufficient. This is Mandatory Gate
#3 (`CLAUDE.md`).

### Preparing an exception

When an exception is actually being prepared for a human decision (not
when it has been abandoned for a safe alternative), the work follows the
SENSITIVE path defined in `CLAUDE.md`, and the main session:

1. prepares items 1–3 above — alternatives considered, a
   dependency/version-specific risk assessment including reachability
   and exposure, and concrete compensating controls — establishing the
   vulnerability with the project's own tooling and sources;
2. then, **before** presenting the package as ready for approval,
   invokes the `project-security-review` Skill, which delegates item 4 to
   `qa-security`; that review must evaluate the actual assessment and
   controls, not restate them. The operator does not need to ask for it;
3. only then presents the package, and requests the item 5 approval
   naming the specific dependency and version.

Preparing a package is not approving it; neither the main session nor
QA/Security may approve an exception. Until that explicit human approval,
the dependency is not installed, committed, merged, deployed or otherwise
adopted under the exception. If facts needed to prepare the package are
genuinely missing, ask for them first.

---

## Irreversible and High-Risk Actions

The following are high-risk and hard or impossible to reverse. None may
be executed against a shared, staging, or production environment without
the specific execution approval defined in `CLAUDE.md`'s Human Approval
section, obtained immediately before execution:

- destructive changes to production data or schema (see
  `.claude/rules/database.md`)
- deleting or de-provisioning production infrastructure
- disabling or weakening an authentication, authorization, or other
  security control, even temporarily or "just for testing"
- a force-push or history rewrite on a shared or protected branch (see
  `.claude/rules/git.md`)
- revoking or rotating a credential or secret where other services may
  depend on it and disruption is possible
- any other action that destroys data, access, or availability in a way
  that cannot be trivially undone

The ability to roll back afterward is not a substitute for approval
beforehand. Approval is required before execution, not after a problem
is discovered. This is Mandatory Gate #5 (`CLAUDE.md`).

---

## Web Session and Cross-Origin Security

Apply the following whenever the project serves browser clients with
cookie/session-based authentication, or exposes an API to browser origins
other than its own:

- Session cookies must be scoped appropriately: secure, http-only, and an
  explicit same-site policy.
- State-changing requests authenticated via cookies must be protected
  against cross-site request forgery (e.g., a CSRF token, or strict
  same-site cookies plus server-side origin checks).
- Cross-origin access must be allow-listed explicitly. Do not reflect an
  arbitrary request origin, and never combine a wildcard origin with
  credentialed requests.

If the project instead uses token-based authentication with no ambient
browser credentials (a bearer token the client sends explicitly), CSRF
protection does not apply, but origin/CORS restrictions still do wherever
the API is reachable from a browser.

---

## Security Failures

Never:

- disable authentication to make development easier
- disable authorization to make tests pass
- expose credentials temporarily and forget to remove them
- suppress security warnings without investigation

Critical security issues block completion.