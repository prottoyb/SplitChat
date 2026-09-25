# Phase state

Resume point for any new session. Read this, then `git log` on the branch
below, before doing anything. Update it at every checkpoint commit. No
secrets here — credentials live only in the operator's environment
(`DB_URL`) and `.env.local`.

## Current

| Field | Value |
|---|---|
| Phase | **1 — database/security hardening: PREPARATION (design only)** |
| Branch | `feature/phase1-db-hardening` (from `chore/capture-schema-baseline`) |
| Last verified checkpoint | CP0 — Phase 1 design + ADRs (this commit; see `git log`). Previous: `cb2db08` Phase 0 baseline (pushed on `chore/capture-schema-baseline`) |
| Next human gate | **Phase 1 design approval** |

## Approved scope (Phase 1 preparation)

- Design the hardening phase from `supabase/baseline/` and the operator's
  decisions; produce a reviewed migration plan and a test-environment
  recommendation.
- Local checkpoint commits at verified milestones are allowed within scope.
- **Not approved:** writing/applying migrations, `migration repair`,
  `db push`, any live database connection or change, installing tools
  (Docker, Supabase CLI, pgTAP), creating Supabase projects, pushing this
  branch, opening PRs, merging.

## Completed

- Phase 0: live `public` schema captured read-only into `supabase/baseline/`;
  reviewed; approved; committed `cb2db08`; pushed for backup (no PR).
- Phase 1 design: `docs/phase1/design.md` (plan, migration sequence M0–M16,
  test plan, test environment, live-operation approvals) and
  `docs/ADR/0001`–`0007`.
- Design reviews:
  - Senior Review: APPROVE WITH CONDITIONS (SR-D1..D4 addressed).
  - QA/Security: round 1 FAIL (DS-1..DS-10, incl. two HIGH). Resolutions
    are in design.md "Review resolutions". Round 2: PASS, with no
    unresolved CRITICAL/HIGH. Its follow-ups DS-11..DS-13 were also applied
    before CP0.

## In progress

- Nothing; waiting at the design approval gate.

## Remaining

- Operator: approve or change the design; answer G1–G5 and SR-D1.
- After approval, per design §E: CP1 test harness (runner, shim, helpers,
  seed), CP2 M0 baseline migration + round-trip proof + characterisation
  tests, then CP3+ migrations M1…

## Open questions blocking later steps (design §G)

- **G1** Let active members see former members' names/avatars? This broadens
  visibility; default is no. Blocks the final M8 helper.
- **G2** Admin role in Phase 1? Default is owner only. Blocks M7/M9/M13
  authorization.
- **G3** Supabase CLI install method (pinned devDependency vs pinned binary).
  Blocks F-W1/F-W2.
- **G4** Approve creating a Supabase cloud dev project for rehearsal? Blocks
  the CA-2 proof and the M11 path.
- **G5** Frontend hosting/deploy process. Blocks M10/M14 ordering.
- **SR-D1** Is M16 (index cleanup) in Phase 1 scope, or deferred?

## Latest checks

At CP0 (docs-only change): lint ✅ · build ✅ (known >500 kB chunk warning) ·
test ✅ 84/84 · npm audit ✅ 0 vulnerabilities — see the CP0 commit message.

## Unresolved risks

Production (pre-existing, unchanged — Phase 1 has changed nothing live):

- CRITICAL QS-1: `expenses` UPDATE policy lets a creator move an expense to
  another group.
- CRITICAL QS-2: `split_chat_is_group_member` is executable by `anon`
  (membership oracle).
- HIGH QS-3: split-sum integrity is bypassable via direct table writes.
- HIGH QS-4: owner account deletion cascades to other members' expenses.
- MEDIUM: blanket grants incl. TRUNCATE; email enumeration via add-by-email;
  frontend/RPC remainder-cent order mismatch.

Project:

- No migration history on prod.
- No CI.
- No DB test environment yet.
- Unverified: Supabase CLI without Docker, and whether triggers on
  `auth.users` are permitted (CA-2).

## Working-tree notes

`src/pages/ActivityPage.tsx`, `AuthPage.tsx`, `DashboardPage.tsx` show as
modified: line-ending-only noise. Never stage, commit or reset them.
