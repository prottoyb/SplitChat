# Deferred and LOW items register (Phases 1–8)

Every LOW, deferred or accepted item recorded in Phases 1–8, with its
Phase 8 decision. Nothing here is CRITICAL, HIGH or MEDIUM. Kept current
until release; Phase 9 (release readiness) picks up the "Deferred" rows.

Legend: **Fixed (P8)** — resolved in Phase 8 · **Resolved** — fixed in an
earlier phase · **Accepted** — by design, with the reason · **Deferred** —
kept, with the reason and where it belongs.

## Database, security, concurrency

| Item (origin) | Decision |
|---|---|
| Expense edit/delete and settlements raced membership changes (architect, P7) | **Fixed (P8)** — M21 + case 243 (fails without M21) |
| Expense creation raced membership removal (P7 QA MEDIUM) | **Resolved** — M20 + case 242 |
| Anonymous Realtime subscribers received "401" notices for every insert/update (P8 audit) | **Fixed (P8)** — M23 + case 245 |
| Realtime DELETE events are not RLS-filtered: an unfiltered subscriber learns the id of rows deleted with a solo group (P6/P8 QA) | **Accepted (LOW, measured)** — id only, no content/group/person; filtered subscriptions receive nothing; no mitigation without replacing Postgres Changes (ADR-0011/0012) |
| `publish = 'insert'` per table (P6 QA OPTIONAL) | **Accepted** — not possible in PostgreSQL (publication-wide option on a platform-owned publication) |
| Global bigint ids on messages/events reveal overall volume (P6/P8) | **Accepted** — low value; noted in ADR-0011 |
| Deferred index cleanup (P1 "M16") | **Fixed (P8)** — M22: redundant indexes dropped, group/date index added (case 244) |
| Partial `group_members (user_id) WHERE left_at IS NULL` index (P1) | **Deferred** — existing `(user_id)` index is already selective; revisit with production statistics (post-release) |
| `settled_on` upper bound enforced by the RPC, not a table CHECK (P4 LOW) | **Accepted** — a CHECK on `current_date` is not immutable (would break restores); client writes are revoked, so the RPC is the only writer |
| Three-way concurrency (account deletion + ownership transfer + add member) reasoned, not tested (P1) | **Deferred (LOW)** — since M21 all three take the group row first, removing the ordering hazard; a dblink test needs deleting an auth user mid-transaction, which the harness cannot do concurrently; post-release |
| M11 is fix-forward only; account-deletion trigger is removable only via `DROP FUNCTION … CASCADE` (P1) | **Accepted** — documented emergency path (phase state) |
| GoTrue soft delete would bypass the deletion trigger (P1) | **Accepted** — hard delete is the supported path; release runbook item (docs/operations/release-runbook.md) |
| Orphaned groups when the sole owner deletes their account; no cleanup/export (P1 DS-3) | **Deferred** — needs a product decision (export/cleanup policy); post-release |
| Add-by-email reveals an account when it is added; membership RPC timing side channels (P1 DS-10) | **Accepted** (operator decision, P1) |
| `supabase_admin` default privileges cannot be changed by `postgres` (P1) | **Accepted** — platform limitation; the catalog audit checks actual grants |
| Event payload privacy relies on writers never adding free text (P8 QA) | **Accepted** — every writer reviewed; the Dev security audit asserts no notes/messages/proposal text in events |
| A person can set their own display name to "Deleted user" (P8 audit) | **Deferred (LOW)** — cosmetic impersonation of a tombstone; reserve the name in a later profile-validation change (Phase 9) |
| Test suites that need SplitChat-Dev (E2E, a11y, API audits) are not in CI (P8) | **Deferred** — needs Dev credentials as repository secrets (operator decision); run before every sign-off (docs/operations/ci.md) |

## Frontend and UX

| Item (origin) | Decision |
|---|---|
| >500 kB chunk warning (P0) | **Resolved** (P2 lazy routes); P8 vendor chunks: entry 16 kB |
| Stale data on route change, strict date validation, error wording, component tests (P0) | **Resolved** (P2: `useResource` keys, `expenseForm` date rule, RPC error map, component tests) |
| `useAuth` / `ProtectedRoute` untested (P0) | **Fixed (P8)** — `ProtectedRoute.test.tsx` (signed-out redirect with return path, no private content while loading) |
| Dashboard loaded every expense to summarise a month; Overview loaded a whole group to show five (P5, P8 review) | **Fixed (P8)** — `since` / `limit` on `listMyExpenses` |
| Overview and Expenses fetch the group's expenses separately (P5 LOW) | **Accepted** — each is now bounded; a shared cache is not needed (ADR-0008 rule 6 triggers have not fired) |
| Chat timeline keeps every loaded message for the life of the view (P6 LOW) | **Deferred** — expense-group chat is low volume and rate-limited (20/min per sender); windowing would complicate scroll anchoring; revisit with usage data |
| `matchMedia('(pointer: fine)')` read per keydown (P6 LOW) | **Accepted** — trivial cost |
| Balances section vertical redundancy on mobile (P5 LOW) | **Deferred** — Phase 9 density pass |
| Overview "next step" repeats the header position (P5 OPTIONAL) | **Accepted** — it carries the action link |
| Long names ellipsised in the half-width "Paid by" select (P5 LOW) | **Accepted** — the native option list shows full names |
| Panel/stat-card styles per module instead of shared tokens; one grey for all secondary text after the contrast pass (P5 LOW, P8 designer LOW) | **Deferred** — Phase 9 design-token pass (2-step secondary/tertiary text scale) |
| "Old proposal" note has no suggested action (P7 LOW) | **Deferred** — Phase 9 copy pass |
| A payer/participant who left before approval shows as "Former member" on the proposal card (P7 LOW) | **Accepted** — approval is refused for them anyway; the Edit page lets the proposer or owner fix the draft |
| Chat tab placement once Smart Expense exists (P7 OPTIONAL) | **Deferred** — revisit with usage |
| Proposal edit history not kept (P7) | **Accepted** — ADR-0012 |
| Mobile main navigation clipped without a cue (P8 designer) | **Fixed (P8)** — fade, snap, current link kept in view |

## Tooling

| Item (origin) | Decision |
|---|---|
| `api.mjs` / `api-batch2.mjs` call the dropped legacy RPC (P1) | **Fixed (P8)** — kept as Phase 1 evidence, refuse to run without `--historical-pre-m14` (scripts/rehearsal/README.md) |
| CI database job had never passed; CI never run on a PR (P1–P7) | **Fixed (P8)** — Unix-socket directory; green since `494cf0d`; Node 24 actions; required checks documented (a PR run happens when the integration PR is opened) |
| Tests saw the production URL; `npm run dev` targeted production by default (P8) | **Fixed (P8)** — test placeholder URL; dev server refuses production without an explicit opt-in |
| One Realtime proof run 22/23 (P8) | **Fixed (P8)** — delivery wait raised to 15 s on the free tier; negative checks unaffected |
| Dev reset script named only the Phase 1 tables (batch 4 dress rehearsal) | **Fixed (P8)** — batch 4 tables dropped, empty publication asserted. LOW (Senior): a catalog-driven drop of every `public` table would avoid missing future tables → **Deferred** to the next schema-adding phase; the "public is empty" post-condition already refuses (one transaction, nothing changed) if a table is missed |
| First behavioural audit after the dress-rehearsal push missed one positive Realtime control, passed on re-run (P8) | **Accepted (LOW, observed once)** — not reproduced in the final clean run; post-release live-chat smoke test in `docs/phase8/release-batch4.md` Risks |
