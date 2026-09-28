# Phase 3 — Dashboard and activity

**Status:** ✅ complete 2026-09-28 (QA/Security PASS, Senior APPROVE). Branch `feature/phase3-dashboard-activity`
(from the Phase 2 head). Architecture: ADR-0009 (append-only event log,
**operator-approved 2026-09-27**, no description snapshot on deletion).

## Scope

1. **Activity model (ADR-0009, option C):** `public.group_events` written by
   the existing SECURITY DEFINER functions in the same transaction; RLS read
   for active members; immutable; backfill of existing history.
2. **Activity feed:** keyset-paginated, names resolved at read time, edits
   described by what changed, deletions by amount and date only.
3. **Dashboard:** real data only — groups, recent activity, "For you"
   attention items, month and week summaries; no balances (Phase 4).

## Outcome

| Item | Result |
|---|---|
| Migration | `20260928100000_activity_event_log.sql` (M16), generated from the current reviewed function bodies; rollback restores them verbatim (discards history → fix-forward once live) |
| Event paths | expense created/updated/deleted; member added/rejoined/removed/left/account deleted; ownership transferred (user and operator release); group created. `delete_group` (solo) records nothing — events cascade |
| Privacy | ids, integer cents, dates and people ids only; edit events store before/after of changed fields plus description/notes flags; deletions keep no description |
| Names | `get_ledger_identities` also covers people referenced by edits and events |
| Harness | case 210 (36 assertions): one event per path, none for refused/rolled-back calls, readers, immutability, cascade, names, backfill; test:db 24/24 (476) |
| Frontend | `features/activity` (API, `describeEvent`, `ActivityFeed`, `ActivityPage` with group filter), `features/dashboard` (summary, attention, groups by last activity); `/groups?create=1` |
| Tests | Vitest 331 (25 files) |

## SplitChat-Dev rehearsal (2026-09-28)

- Dev was at the full batch-3 schema (17 versions). Read-only snapshot:
  22 groups, 23 non-creator memberships, 15 departed memberships, 12
  expenses.
- Pinned CLI `db push` from a staging copy: applied only `20260928100000`.
- Backfill exactly matched the snapshot: `group_created` 22, `member_added`
  23, `member_left` 3 + `member_removed` 1 + `member_account_deleted` 11 = 15,
  `expense_created` 12; no live events yet.
- Ledger snapshot identical before/after; dev schema == harness schema after
  M16: **IDENTICAL (2056 normalised lines)**.
- `scripts/rehearsal/api-activity.mjs` (supabase-js + real GoTrue):
  **11/11** — exact event sequence for eight actions, no description/notes
  text in payloads, edit changes recorded, outsider / removed member / anon
  read nothing, client insert/delete refused (42501), removed member still
  named, real account deletion records `member_account_deleted` with no
  actor.

## Reviews

- **Software Architect** (ADR-0009): FIT WITH CONDITIONS; conditions 1–13
  implemented.
- **QA/Security:** PASS. One MEDIUM (the keyset cursor was interpolated
  into the PostgREST `or()` filter) fixed in `9340f89`: the cursor is
  validated as a strict server timestamp and a positive safe integer before
  any query is built; re-verified RESOLVED.
- **Senior Review:** APPROVE after two passes; two LOWs (cursor invariant,
  inconsistent defensive payload reads) fixed in `1e32a9c`.

## Production

Not applied. M16 joins the next production release batch (with the Phase 4+
migrations), with its own pre-checks, post-checks, expected schema and
execution approval.
