# SplitChat — product vision

## What SplitChat is

SplitChat is a web app for groups who share costs: flatmates, trips,
couples, clubs. Members record shared expenses, see who owes whom, settle
up, and talk about spending in a group chat. The chat can turn a message
like "dinner 84.50 split with Sam and Alex" into a proposed expense that a
person reviews before it is saved.

It is intended to be genuinely usable by real people, not a feature demo.

## Target experience

- Sign up, create a group, add friends by email, and record the first
  expense in about a minute.
- Always know your position in each group (you owe / you are owed), and
  settle up in as few payments as possible.
- Trust the numbers. Every cent is accounted for, splits are predictable,
  and the history can be understood even after people leave.
- It works well on a phone and on a desktop, is accessible, and gives clear
  loading, empty and error states.

## Core capabilities (release scope)

- Accounts and profiles (Supabase Auth).
- Groups with an **Owner** and **Members**. Ownership is transferable.
  Members can leave; the owner can remove members.
- Expenses with **equal** splits: create, view, edit, delete, with
  server-enforced permissions.
- Balances, debt simplification and recorded settlements.
- Dashboard and activity history.
- Group chat.
- **Deterministic Smart Expense**: rule-based interpretation of natural
  language plus a structured command fallback. It produces a *candidate*
  expense that the user reviews, edits, approves or rejects, and that is
  saved only through the canonical expense service. No opaque AI decides
  money.

## Quality goals

Correctness, security, data integrity, reliability, usability, responsive
and accessible UX, maintainability, testability, deterministic financial
behaviour, safe migrations, clear errors, sensible performance,
reproducible setup, safe deployment, and useful documentation.

## Security and data integrity

- Authorization is enforced in the database (RLS, grants, SECURITY DEFINER
  RPCs with authorization checked first), never only in the UI.
- Groups are tenant boundaries: no data crosses between groups.
- The ledger is append-safe and consistent: splits always sum to the
  expense; cents are conserved in every split and balance calculation.
- Historical records survive account deletion and membership changes.
  Deleted users are tombstoned, showing only the minimal identity needed
  to understand a record.
- Least privilege: anonymous callers get nothing; clients get only what the
  UI needs.
- Every schema change is a reviewed, source-controlled migration. The
  production database is never an experimental environment.

## Money

- **AUD only** for this release. No exchange rates, no multi-currency.
- Application, domain and API values are **integer cents**.
- Equal splits use one canonical participant order (ascending UUID) and one
  remainder rule, implemented identically in the frontend and the database
  and tested against shared vectors.

## Out of scope (unless explicitly approved later)

- Exact-amount and percentage split modes (post-MVP).
- Multi-currency and exchange rates.
- Email invitations or token delivery. Members are added by the email of
  an existing account.
- A group Admin role separate from the Owner.
- Payment processing or bank integrations.
- Native mobile apps.
- LLM-based expense interpretation.

## Principle: simplest robust architecture

React + TypeScript + Vite single-page app, with Supabase for Auth,
Postgres, RLS and Realtime. There is no custom backend server unless a real
need appears. No microservices, Kubernetes, queues, speculative
abstractions or fashionable dependencies without demonstrated benefit.
Prefer database constraints and small, well-tested pure functions to
clever infrastructure.

See `docs/roadmap.md` for sequencing and `docs/ADR/` for decisions.
