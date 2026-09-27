# Phase 6 — Group chat

**Status:** ✅ COMPLETE 2026-09-28 on `feature/phase6-group-chat`
(UI/UX rendered review APPROVE AFTER FIXES → fixed and measured;
QA/Security PASS; Senior Review APPROVE). Design: ADR-0011.

## Delivered

| Area | What |
|---|---|
| Migration | M18 `20260928120000_group_messages.sql`: immutable `group_messages` (guard trigger; only the solo-group cascade deletes), `send_group_message` (authorization → validation → group KEY SHARE → membership FOR SHARE → per-sender advisory lock → idempotency → 20/min, 1000/day → insert), RLS read for active members, no client writes, table in `supabase_realtime`; `get_ledger_identities` also names former members who sent a message (G1 kept — the draft's "every past member" was caught by the existing regression and amended in the ADR). Rollback restores M16's function verbatim; fix-forward once messages exist |
| Harness | shim creates the platform's empty `supabase_realtime` publication; case 230 (55 assertions: surface, isolation, outsider/anon/forged sender, body boundaries, idempotency, keyset ties, rate limit, left/removed/deleted/re-added, G1, immutability, cascade), case 231 (dblink: send vs removal in both orders, concurrent sends at the limit); inventories 010/150 updated; **test:db 28/28 (629)** |
| Frontend | `features/chat` (strict parser, keyset paging, Postgres Changes subscription on a validated group id, timeline reducer with microsecond ordering, id de-dup, pending/failed/retry/discard, gap-fill on every (re)subscribe/online/visible, replacement handling), `GroupChat` UI, workspace **Chat** tab; compact workspace header on mobile chat |
| Tests | Vitest **439/439** (33 files; chat 41) · lint · build · audit 0 |

## SplitChat-Dev rehearsal (2026-09-28)

- Dev at 19 versions; pinned CLI `db push` from a staging copy applied only
  `20260928120000`. Publication before: exists, owner `postgres`, not
  `FOR ALL TABLES`, empty; after: `public.group_messages` only.
- Read-only ledger fingerprint identical before and after.
- Dev schema == harness schema after M18: **IDENTICAL (2677 normalised lines)**.
- `scripts/rehearsal/api-chat.mjs` **25/25** with real users, JWTs and
  Realtime: member receives exactly one INSERT; outsider (filtered and
  unfiltered), former member and anon receive nothing (they can open a
  channel but get no rows); removed member stops receiving from the next
  message; delivery survives a JWT refresh; direct insert/update refused;
  idempotent retry; `duplicate_request`; `invalid_body`; former sender
  nameable; no `group_events`.
- Rendered review (`render-review.mjs`, seeded conversation): composer
  measured inside the first viewport at 1440 / 900 / 390.

## Reviews

- **UI/UX:** HIGH mobile composer below the fold → compact header on the
  Chat tab + near-full-height chat scrolled into view (measured visible);
  MEDIUM failed-send visibility → stronger outline + warning icon; LOW
  timestamp contrast and Retry/Discard names → fixed. MEDIUM "Phase 7 card
  slot" → carried into Phase 7 (ADR-0012 CandidateCard).
- **QA/Security:** PASS. LOW accepted: Realtime DELETE events are not
  RLS-filtered (bigint id only, solo-group cascade only, nobody subscribes).
  OPTIONAL declined: per-table `publish = 'insert'` does not exist in
  PostgreSQL; `publish` is publication-wide and the publication is
  platform-owned.
- **Senior:** APPROVE. MEDIUM (list replacement after a long disconnect
  reflowed under the reader) → `epoch` in the timeline; the view jumps to
  the latest; LOW comment added. The architecture test runs under Vitest
  (4/4), not bare `node`.
- Process note: `648f424` was pushed with a `tsc -b` error in a test (the
  command chain did not stop on the failed build); fixed in `4edcc55`.
  Checks are now gated on exit codes.

## Deferred

- LOW: timeline keeps every loaded message for the life of the view (no
  windowing); fine at expected group sizes — Phase 8 performance pass.
- LOW: `matchMedia('(pointer: fine)')` read per keydown (trivial).
- Found by the Phase 7 architect, pre-existing (not Phase 6):
  `create_equal_split_expense_v2` checks membership without locks, so a
  manual expense can race with a member removal (the expense then includes
  someone removed a moment earlier). To be rated by QA/Security and fixed
  in Phase 8 (the Phase 7 core refactor locks memberships for approvals).
