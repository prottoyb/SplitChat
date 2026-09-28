# Integration PR: Phases 2–8 into `main` (prepared, not opened)

Opening and merging the PR are operator actions. `main` is at `02d6d64`
(Phase 1); `feature/phase8-hardening` carries Phases 2–8 as one linear
chain (`git log --oneline 02d6d64..HEAD` for the current count).

## Integration path

1. Open a PR `feature/phase8-hardening` → `main` with the description below.
2. CI must pass on the PR (both required checks; see `docs/operations/ci.md`).
3. Review and approval on the PR by the operator.
4. Merge with a **merge commit** (not squash, not rebase): the phase
   records cite checkpoint commits by hash (e.g. `0552b2d`, `81d73ce`,
   `4d7c2ab`, `494cf0d`); rewriting them would orphan those references.
5. Merging does **not** change production. The database batch and the
   frontend deployment follow `docs/operations/release-runbook.md` and
   `docs/operations/deployment.md`, each with its own approval.

The intermediate branches (`feature/phase2…` to `feature/phase7…`) are
ancestors of this branch and can be deleted after the merge (operator).

---

## PR description (to paste)

**Title:** Phases 2–8: product features, hardening and release preparation

**What changed**
- Phase 2: feature-module frontend (ADR-0008), data layer, expense edit UI.
- Phase 3: append-only activity log and real dashboard (ADR-0009, M16).
- Phase 4: server-authoritative balances, debt simplification, settlements
  (ADR-0010, M17).
- Phase 5: group workspace (overview, expenses, balances, activity,
  members), header position, dashboard positions.
- Phase 6: group chat with Realtime (ADR-0011, M18).
- Phase 7: deterministic Smart Expense — interpreter → proposal → human
  review → approval through the canonical expense core (ADR-0012, M19, M20).
- Phase 8: concurrency discipline (M21), index cleanup (M22), anon Realtime
  silence (M23), security/accessibility/E2E audits and fixes, CI fixed,
  production batch 4 prepared.

**Why**: the approved roadmap (Phases 2–7) plus Phase 8 hardening.

**How it was tested**
- `npm run lint`, `npm run build`, `npm test` (Vitest, incl. architecture
  rules), `npm audit`, `npm run test:db` (harness incl. rollbacks, dblink
  concurrency cases and the catalog security audit) — also in CI.
- On SplitChat-Dev (never production): API/RLS/Realtime checks (security
  audit 162/162 and feature checks), E2E 20/20, rendered accessibility
  audit 0 findings, schema identical to the harness after each migration,
  production tool rehearsal (verify and audit PASSED).

**Known limitations**: `docs/phase8/deferred-register.md`.

**Security considerations**: authentication/authorization, data access
and untrusted input are all touched. Authorization is enforced in the
database (RLS, least-privilege grants, SECURITY DEFINER RPCs with
authorization first and an empty `search_path`); QA/Security reviewed every
phase (PASS) and the Phase 8 audits (`docs/phase8/plan.md`). No new
runtime dependency. Merging changes no environment.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
