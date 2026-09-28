# Phase 8 — Hardening and production-release preparation

**Status:** **complete** on `feature/phase8-hardening` (from the Phase 7 head
`4d7c2ab`), at the completion gate; reviews below, no open CRITICAL/HIGH/
MEDIUM. Operator product decisions of 2026-09-29 are
recorded in ADR-0011, ADR-0012 and the product vision.

## Outcome by scope item

| # | Scope | Result |
|---|---|---|
| 1 | Expense edit/delete concurrency | **M21**: edit re-checks payer/participants under membership locks; edit/delete authority re-checked under the caller's membership lock; remove/leave/transfer take the group row first so the settlement RPCs' re-check serialises. The obvious alternative (membership locks inside the settlement RPCs) was rejected: it deadlocks with removal/transfer. Case 243 (17 assertions, dblink, both orders; fails without M21). M20 (Phase 7) covers creation (case 242). |
| 2 | E2E | `npm run test:e2e`: 20 journeys in real Chrome on SplitChat-Dev (4 users, desktop + mobile), by role/accessible name with hit-tested clicks; fails on any request outside localhost/Dev or any page error. 20/20 (repeated). Found and fixed: unlabelled sidebar icons, crushed expense split breakdown, an unusable in-chat proposal editor (now an Edit proposal page). |
| 3 | DB/RLS/Realtime security audit | Static (QA/Security) PASS; behavioural `api-security-audit.mjs` 162/162 (anon/outsider/former member × 8 tables, 16 RPCs, private schema, event payload privacy, Realtime 5 tables × 3 roles × filtered/unfiltered with joined-listener and control checks); catalog `security_audit.sql` 12 checks = 0 (Dev, harness, CI). Found and fixed: anonymous Realtime "401" timing notices (**M23**). Accepted LOW: id-only DELETE events on solo-group deletion. |
| 4 | Accessibility | `npm run test:a11y`: 12 screens × desktop/mobile — Chrome AX names, keyboard traversal with visible-focus check, contrast, landmarks/headings, 44px touch targets. 162 findings → 0. Contrast pass (61 colours; dark surfaces lightened), 12px text floor, 44px targets on touch devices, confirmations keyboard-safe (Cancel focused, Escape, focus return), proposal status announced, labelled main nav, named group cards. UI/UX rendered review: APPROVE AFTER FIXES → fixed. Stricter final audit (non-text alternatives, gradient stops and ancestor opacity, 3:1 focus rings): 38 findings, all the sidebar links and Sign out relying on the browser's default ring (1.07:1 on the dark sidebar) → explicit `#7054f6` ring (inset in the scrolling mobile nav) → 0. |
| 5 | Performance / bundle | No >500 kB warning existed (Phase 2). Vendor chunks: entry 16 kB (was 192 kB); initial ~133 kB gzip unchanged, vendor cached across deploys. Dashboard now loads one month of expenses (was all); Overview loads five (was the whole group). Chat memory windowing deferred with rationale. |
| 6 | Index cleanup | **M22**: redundant `expense_splits_expense_id_idx` and `expenses_group_id_idx` dropped, `expenses_group_date_idx` added (planner proof, case 244); partial membership index deferred (no gain). |
| 7 | CI | The database job had **never** passed (32 runs): Unix-socket directory on Linux; fixed (`494cf0d`), green since. Node 24 actions (pinned), manual dispatch, failure summary as a public annotation, the catalog audit inside the harness, required checks documented (`docs/operations/ci.md`). |
| 8 | Historical scripts | `api.mjs`, `api-batch2.mjs` refuse to run without `--historical-pre-m14`; `scripts/rehearsal/README.md` lists current vs historical tools. |
| 9 | LOW/deferred items | `docs/phase8/deferred-register.md` classifies every item of Phases 1–8. |
| — | Tooling safety | Tests saw the production URL (`.env.local`): now a non-routable placeholder; `npm run dev` refuses production without an explicit opt-in. The rehearsal browser also checks WebSockets (Realtime) against its allowlist and blocks any URL with the production ref; `scripts/rehearsal/browser-guard-selftest.mjs` proves both, with allowed-traffic controls. |
| — | Release preparation | `batch4` in `scripts/ops/prod.mjs` (+ `audit`), pre/post checks, expected schema, `docs/phase8/release-batch4.md`, `docs/operations/{release-runbook,deployment}.md`. Not executed. |

## Validation (Phase 8 sign-off)

See `docs/phase-state.md` (Validation status) for the final counts.

## Reviews

- **UI/UX (rendered):** APPROVE AFTER FIXES (HIGH small touch targets/text,
  MEDIUM approval confirmation keyboard gap) → fixed and re-audited.
- **QA/Security:** static audit PASS; Realtime DELETE MEDIUM downgraded to
  an accepted LOW on measured evidence; endorsed M23. Final Phase 8 review
  (run as focused passes so each scope was read in full):
  - M21 lock discipline, M23, CI, dev-server guard: **PASS** (deadlock-free
    lock order checked against the row-lock matrix; authority re-checked
    under lock; case 245 a genuine regression test). LOW: action SHAs not
    verified against upstream → verified (`git ls-remote`: checkout v7.0.1
    `3d3c42e5…`, setup-node v7.0.0 `82076278…`).
  - Release package (`prod.mjs`, pre/post checks, audit, runbooks): **PASS**
    (all 8 hashes recomputed; approval/attestation gates; env scrubbing;
    read-only guard; prechecks not inverted; postchecks non-tautological).
    OPTIONAL real-output fixture → added. LOW: full dress rehearsal from a
    Dev reset still outstanding → recommended precondition (needs approval).
  - App changes: no CRITICAL/HIGH; LOW proposal URL group not checked →
    fixed (`d2553b1`).
  - Test tooling: **PASS** with MEDIUM: WebSockets (Realtime) bypassed the
    browser's request allowlist → fixed (`webSocketCreated` check against the
    same list + production ref blocked outright); historical guards PASS; no
    secrets logged.
  - Closure (final session): WebSocket fix and `browser-guard-selftest.mjs`
    **PASS** (fails closed, self-test non-vacuous, every caller fails on a
    socket violation). HIGH raised: `e2e.mjs` and `render-review.mjs` printed
    a violating origin unredacted, so a production socket would print the
    production ref → redacted (`<production-ref>`) → re-verified, closed.
    Final verdict: **PASS**.
- **Senior Review** (focused passes):
  - M21: no defect. MEDIUM duplicated audit parser → fixed (`7a3b171`: one
    exact 12-check parser, unit-tested).
  - M22/M23, rollbacks, cases 243–245, `test:db` 35/35: **APPROVE**.
  - Frontend (confirmations, CandidateCard, EditProposalPage, AppLayout):
    MEDIUM Edit/Add details links not disabled while busy → fixed
    (`d2553b1`). ProtectedRoute, CSS: **APPROVE**; LOW `-webkit-mask-image`
    → added.
  - a11y heuristics: **APPROVE** with MEDIUMs → fixed: images/non-text
    content now need a text alternative; contrast includes gradient stops and
    ancestor opacity (image backgrounds reported for manual review); focus
    rings must have 3:1 contrast. Remaining stated limits in the script header.
  - Closure (final session): the stricter audit found the sidebar focus
    rings (1.07:1) → explicit ring, **APPROVE** (3.62:1 on the sidebar, 4.90:1
    on the active item). MEDIUM: a ring was always judged against the
    parent's background, so an inset ring was never tested against the
    element's own → each ring now judged on the surface it is painted on;
    proven by a probe (a ring weak only on white is flagged, 2.72:1).
    Final verdict: **APPROVE**.
  - Main merge: MEDIUM stale `docs/phase-state.md` → fixed; LOW stale counts
    in the PR text → removed.
  - Release docs: **READY**; LOWs (attestation variable not cleared,
    evidence folder) → fixed.
- **Batch 4 dress rehearsal** (operator-approved, 2026-09-29; results in
  `docs/phase8/release-batch4.md`): two tooling fixes (reset script covers
  the batch 4 tables and asserts an empty publication; preflight info rows
  cover all four M16 backfills) — QA/Security **PASS**, Senior **APPROVE**
  (LOW catalog-driven drop → deferred register).
