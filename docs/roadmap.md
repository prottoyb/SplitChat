# SplitChat roadmap

Each phase starts only after human approval and ends with a phase
completion report followed by a human gate. The detailed state of the
current phase is in `docs/phase-state.md`.

| # | Phase | Status |
|---|---|---|
| 0 | Production schema baseline capture | ✅ Done (`cb2db08`) |
| 1 | Database and security foundation | ✅ Complete in production (2026-09-27; batches 1, 2, 3a, 3b verified); accepted and merged to `main` |
| 2 | Frontend/domain consolidation | ✅ Complete (2026-09-27, `feature/phase2-frontend-domain`) |
| 3 | Dashboard and activity | ✅ Complete (2026-09-28, `feature/phase3-dashboard-activity`; M16 awaits a production release batch) |
| 4 | Balances, debt simplification and settlements | ✅ Complete (2026-09-28, `feature/phase4-balances-settlements`; M17 awaits a production release batch) |
| 5 | Group navigation and product UX integration | 🔄 In progress (`docs/phase5/plan.md`) |
| 4 | Balances, debt simplification and settlements | Not started |
| 5 | Group navigation and product UX integration | Not started |
| 6 | Group chat | Not started |
| 7 | Deterministic Smart Expense | Not started |
| 8 | Full integration, security and QA hardening | Not started |
| 9 | Portfolio/release readiness | Not started |

## Phase 1 — Database and security foundation
- **Outcome:**
  - Supabase schema under migration control (baseline + history repair).
  - CRITICAL/HIGH security, authorization, financial-integrity and
    lifecycle problems fixed: cross-group expense move, anonymous
    membership oracle, direct ledger writes, owner-deletion cascade,
    blanket grants.
  - Soft membership history, transferable ownership and
    ledger-preserving account deletion.
  - An integer-cent RPC boundary with canonical split ordering.
  - Expense update/delete RPCs.
- **Design:** `docs/phase1/design.md`, ADR-0001–0007. M16 (index cleanup)
  is deferred to Phase 8.
- **Dependencies:** Phase 0 baseline; the pinned Supabase CLI; the local
  PG17 harness; the SplitChat-Dev rehearsal project.
- **Human gates:**
  - every production operation (history repair, each migration or batch,
    data fixes, operator ownership release);
  - deleting SplitChat-Dev;
  - phase completion.

## Phase 2 — Frontend/domain consolidation
- **Outcome:**
  - Split oversized page components.
  - Consolidate duplicated helpers and styles (e.g. money formatting).
  - Clear feature boundaries and a domain layer over Supabase calls.
  - Pay down technical debt without rewriting working behaviour.
- **Dependencies:** Phase 1's RPC/error contract.
- **Gate:** phase start and completion.

## Phase 3 — Dashboard and activity
- **Outcome:** real dashboard data in place of placeholders, and the
  chosen activity/history architecture (ADR) implemented.
- **Dependencies:** Phases 1–2; membership history from Phase 1.
- **Gate:** phase start (architecture choice) and completion.

## Phase 4 — Balances, debt simplification and settlements
- **Outcome:**
  - Deterministic balance calculation (cent-conserving).
  - Repayment simplification.
  - Settlement recording.
  - A usable balances UX.
- **Dependencies:** Phase 1 ledger invariants and integer-cent boundary.
- **Gate:** start (settlement model ADR), production migrations,
  completion.

## Phase 5 — Group navigation and product UX integration
- **Outcome:** a coherent group-level navigation and information
  architecture, bringing existing and new capabilities into one product
  experience.
- **Dependencies:** Phases 2–4.
- **Gate:** start and completion.

## Phase 6 — Group chat
- **Outcome:** secure group messaging with appropriate realtime, loading
  and pagination behaviour, and RLS equal to group membership.
- **Dependencies:** Phases 1 and 5; Supabase Realtime.
- **Gate:** start (realtime/RLS design), production migrations,
  completion.

## Phase 7 — Deterministic Smart Expense
- **Outcome:**
  - Rule-based natural-language interpretation plus a structured command
    fallback.
  - Candidate review, edit, approve and reject.
  - Saving only through the canonical expense service.
- **Dependencies:** Phases 1, 4 and 6.
- **Gate:** start and completion.

## Phase 8 — Full integration, security and QA hardening
- **Outcome:**
  - End-to-end regression.
  - RLS/security testing.
  - Edge cases.
  - Performance, including the indexes deferred from M16.
  - Accessibility and responsive validation.
- **Dependencies:** Phases 1–7.
- **Gate:** start and completion.

## Phase 9 — Portfolio/release readiness
- **Outcome:**
  - Choice of deployment platform and deployment.
  - README.
  - Architecture and security documentation.
  - Demo and screenshots.
  - Repository cleanup.
  - Release validation.
- **Dependencies:** Phase 8.
- **Gate:** start, production release, and completion.

Exact and percentage split modes remain post-MVP unless explicitly approved.
