# Production release batch 4 — evidence package

**Status:** prepared, rehearsed, and **dress-rehearsed end to end from a
clean reset (2026-09-29)**; **not executed**. Execution needs the
operator's explicit approval of batch 4 (Mandatory Gate #5) and follows
`docs/operations/release-runbook.md`. Production is still at the Phase 1
state (17 versions; last verified 2026-09-27).

## Migrations, in order

| # | File | SHA-256 (LF) | Adds | Rollback class |
|---|---|---|---|---|
| M16 | `20260928100000_activity_event_log.sql` | `493f5f5c7d32ff4b1d0652abf4f7032e195a5d8e43ff7d4f0ca42ba0aff6fafc` | `group_events` (append-only, RLS), events written inside the RPCs, backfill of creation/membership events | fix-forward once events exist |
| M17 | `20260928110000_settlements.sql` | `fb03143a00b4fb67b3faba07189eddf61123f9283981d693eef7d5971b8b1896` | `settlements`, server balances, record/void | fix-forward once payments exist |
| M18 | `20260928120000_group_messages.sql` | `fb817c1359e817219fe5f650a5c6504dff152ff716bc7d623e648320a207b03e` | `group_messages`, `send_group_message`, Realtime publication | fix-forward once messages exist |
| M19 | `20260929100000_smart_expense_candidates.sql` | `6aab0d73ab1daa388291d7a0291b9c9c782275065a3d03b34046de734aab334f` | `expense_candidates` + 4 RPCs, shared private expense core (v2 contract unchanged), Realtime | fix-forward once proposals exist |
| M20 | `20260929110000_expense_core_membership_locks.sql` | `5e4fce9b920d34ff2facdacc1c0a5213718e1040355edd7b7c5a4d091ac63b5d` | expense creation holds its members | safe rollback |
| M21 | `20260930100000_membership_and_expense_edit_locks.sql` | `e681e7cb7951df0c2cfe61132dbb3c885b034c282667afa605a51f183f625975` | edit/delete/settlement vs membership lock discipline | safe rollback |
| M22 | `20260930110000_index_cleanup.sql` | `60324cf9ea346a2384c4271137b3dded5ac51e2898bbdd393fe406f17288591f` | index cleanup | safe rollback |
| M23 | `20260930120000_realtime_anon_silence.sql` | `75e672d334486c551378c80a9a5c52ce752f1222cd068e35c0d79e1c16d54b19` | anon Realtime silence (restrictive deny) | safe rollback |

Dependency order is the timestamp order (each builds on the previous; M19
needs M18's table, M20 changes M19's core, M21 follows M20's discipline).

## Expectations checked by the tool (`scripts/ops/prod.mjs --batch batch4`)

| | Before | After |
|---|---|---|
| Schema (public + private, normalised, exact) | `supabase/ops/batch3b_expected_schema.sql` (`0804dc02…ea5c`) | `supabase/ops/batch4_expected_schema.sql` (`c571e828…c46c`), exported from the harness after M23 |
| Migration history | 17 versions (M0–M15 + `20260927135000`) | those + the 8 above = 25 |
| Realtime publication `supabase_realtime` | exists (Q20), not FOR ALL TABLES (Q21), **no tables** (Q22) | exactly `group_messages`, `expense_candidates` |
| Ledger (counts, totals, digests of expenses/splits/groups/memberships/profiles) | snapshot | identical (batch 4 writes no ledger data; M16 only adds events) |
| Post-checks | — | 13 named checks, all true |
| Catalog security audit | — | 12 checks, 0 offending rows (`audit`) |

Frontend compatibility: additive for the batch-3b frontend (every existing
RPC keeps its signature, grants and errors; v2's `expense_created` payload
unchanged), so it can run while any frontend containing `a5ed4e8` is live
(attestation required). The Phase 3–8 frontend **needs batch 4 first**.

## Evidence

| Evidence | Result |
|---|---|
| Local harness (`npm run test:db`): baseline round-trip, every migration's rollback up/down/up, 34 case files incl. real concurrent sessions (dblink), plus the catalog audit | **35/35, 777 assertions** |
| CI (GitHub Actions, both jobs) | green (first green database job `494cf0d`) |
| SplitChat-Dev: each migration applied alone on top of production's replayed path; ledger fingerprint identical before/after each; Dev schema compared to the harness after each | **IDENTICAL** after every step (final 3318 normalised lines) |
| SplitChat-Dev, production tool rehearsal (`--rehearse-on-dev`) on the post-batch state | preflight correctly **refuses** (drift, history, Q22); dry run stages hash-verified copies; **verify PASSED** (13/13, schema exact); **audit PASSED** |
| SplitChat-Dev API checks | security audit **162/162**; chat 25/25; Smart Expense 23/23; settlements 19/19; activity 11/11 |
| End-to-end (real Chrome, SplitChat-Dev) | **20/20** journeys, twice |
| Rendered accessibility audit (final, stricter rules) | 24 page views, **0 findings** |
| Browser production-safety guard self-test (HTTP + WebSocket, with controls) | **7/7 PASS** |

## Dress rehearsal from a clean reset (2026-09-29, operator-approved)

The exact production procedure, on SplitChat-Dev only (ref
`opviwtyfssxoheigflxw`, sentinel verified by `dev.mjs` and `prod.mjs`
before any write); production not contacted; synthetic data only; no
billing or plan change. Run twice: once to find issues, then once more,
clean, with the final reviewed tooling (the results below are that final
run; every step had its expected exit code).

**Reset.** `reset-dev-to-empty.sql` (sentinel re-checked in the database;
one transaction; post-conditions asserted) removed the SplitChat objects
(now including the batch 4 tables, which also empties `supabase_realtime`),
`private`, the CLI history, both SplitChat triggers on `auth.users` and all
synthetic users.

**Replay of production's path** with `prod.mjs --rehearse-on-dev`, as in
production: M0 applied directly → `api.mjs seed` → batch 1 (preflight,
`repair-m0`, dry-run, push, verify **PASSED**) → batch 2 (API prepare,
preflight, dry-run, push, verify **PASSED**, API **44/44**) → batch 3a
(verify **PASSED**, API **36/36**) → batch 3b (verify **PASSED**, API
**28/28**). Dev was then production's recorded state: 17 versions,
schema == `batch3b_expected_schema.sql`.

**Batch 4 (the production procedure).**

| Step | Result |
|---|---|
| `identify` | SplitChat-Dev, 5 public tables, history present |
| `preflight` | **PREFLIGHT PASSED**: schema exact; 17 versions; Q4 = Q5 = 0; Q20 = Q21 = Q22 = 0 (publication exists, not FOR ALL TABLES, no tables); 0 locks, 0 long transactions; backfill info 12 + 15 + 5 + 8 |
| `dry-run` | exactly M16–M23, in order |
| `push` without approval / with `batch3b` approval / without attestation / attesting `f32b56d` (lacks `a5ed4e8`) | all **refused**, nothing written |
| `push` (`SPLITCHAT_PROD_APPROVAL=batch4`, `no-live-frontend`) | M16–M23 applied |
| `push` again | **refused** (history is no longer the batch 4 start) |
| `verify` | **VERIFY PASSED**: 25 versions; 13/13 post-checks (RLS on every table; client write privileges; M23 anon deny; publication exactly `group_messages`, `expense_candidates`; no anon/PUBLIC execute; definer search_path; private expense core; M22 index set; M16 backfill; ledger balanced); ledger unchanged; schema == `batch4_expected_schema.sql` |
| `audit` | **AUDIT PASSED**: 12 catalog checks, 0 rows |
| `preflight` after the push | correctly **refuses** (drift, 25 versions, Q22 = 2) |
| M16 backfill | 40 events = the preflight's info rows (12 groups + 15 memberships + 5 departures + 8 expenses) |

**The migrated state.**

| Check | Result |
|---|---|
| Invariant sweep (read-only; unbalanced, missing or uneven splits, owners, non-member splits/payers/settlement parties, candidate/expense link, one `group_created` per group, message/candidate authors) | **11/11 = 0**, right after the push and again after all suites (25 groups, 18 expenses, 7 settlements, 16 messages, 9 proposals, 115 events) |
| Behavioural security audit (anon / outsider / former member; tables, RPCs, private schema, Realtime) | **162/162**, first Realtime use after the push and again |
| Activity / settlements / chat / Smart Expense APIs | **11/11**, **19/19**, **25/25**, **23/23** |
| Real-API race (owner deletion vs add-by-email, real sessions) and CA-2 (account deletion) | **6/6**, **26/26** |
| M20/M21 race protection | schema identical to the harness, where cases 242/243 prove it with concurrent sessions (35/35) |
| E2E (real Chrome) / accessibility | **20/20** / 24 page views, **0 findings** |

Findings, both fixed and reviewed (QA/Security PASS, Senior APPROVE):
- the reset script predated batch 4 (it would have refused on a
  post-batch-4 Dev: fail-safe, but unusable) → drops the batch 4 tables,
  asserts an empty publication;
- the preflight announced 27 backfill events where M16 writes 40 (it
  counted groups and memberships only) → info rows for ended memberships
  and expenses added (`batch4_prechecks.sql`; not a Q-check, no gate
  change).

Observation: in the first (exploratory) run the first behavioural audit
after the push missed one positive Realtime control (an active member's
live message) and passed on re-run; not reproduced in the final run. See
Risks.

## Risks

- Lock timeouts: every file sets `lock_timeout = 5s`; the preflight lock
  check must show no other locks or long transactions. On timeout, the
  file rolls back and the push stops (retry later).
- M16's backfill inserts one event per group, non-founding membership,
  ended membership and expense (the four info rows; their sum is the
  `group_events` count right after the push).
- Realtime warm-up: once, right after the rehearsal push, the first live
  chat delivery was missed (passed on re-run; not reproduced). Messages are
  stored either way (a reload shows them); after the production push,
  smoke-test a live chat message between two sessions.
- Publication change: if the dashboard had published a table (Q22 ≠ 0),
  stop and assess.
- Accepted residual (LOW): Realtime DELETE events are not RLS-filtered;
  only solo-group deletion produces them and they carry only an id.

## Reviews

- QA/Security: release package **PASS** (hashes recomputed, gates, env
  scrubbing, read-only guard, pre/post-check semantics); M21/M23 **PASS**.
- Senior Review: release docs **READY**; M21–M23 **APPROVE**.
- Both recommended the full dress rehearsal as a precondition to
  execution approval: done (above). Its two tooling fixes: QA/Security
  **PASS**, Senior **APPROVE** (LOW: a catalog-driven table drop in the
  reset script would avoid missing future tables; deferred register).
  Details: `docs/phase8/plan.md` (Reviews).
