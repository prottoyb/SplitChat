# ADR-0011: Group chat

**Status:** Accepted 2026-09-28 (Software Architect design; team adoption
under the operator's 2026-09-28 instruction to build chat on the existing
Supabase stack including Realtime, "a clear architecture first, then
execute it"). Built and tested locally and on SplitChat-Dev in Phase 6;
production only in a later reviewed release batch with its own execution
approval. **Operator-approved product decisions (2026-09-29):** chat
messages are permanent; they cannot be edited or deleted; after account
deletion historical messages remain and show the sender as "Deleted user".

## Context
Phase 6 adds group chat: group-scoped, persistent, realtime, deterministic
order, paginated, visible only to active members like every other table
(ADR-0003), kept through membership changes and account deletion
(ADR-0004, ADR-0005). Phase 7 turns messages into expense candidates, so a
message must be a stable, immutable reference. Constraints: no backend of
our own, least privilege, writes through authorization-first SECURITY
DEFINER RPCs, Supabase free tier.

## Options considered
**Write path.** (A) Direct INSERT under an RLS `WITH CHECK`: cannot return
the existing row on an idempotent retry, cannot rate-limit atomically, and
reopens a client write grant ADR-0003 closed. (B) RPC `send_group_message`.

**Realtime.** (1) Postgres Changes on the table: Realtime evaluates the
table's SELECT policy per subscriber per change with that subscriber's JWT.
(2) Client Broadcast on private channels with RLS on `realtime.messages`.
(3) Broadcast from Database (trigger → `realtime.send`). (2) and (3) check
authorization at channel join (and token refresh) and cache it, so a removed
member keeps receiving until reconnect; (2) also lets any member broadcast
forged payloads; (3) copies bodies into `realtime.messages` and adds a
second policy set that must track membership. (1) costs one RLS check per
subscriber per insert — irrelevant at this product's scale.

**Events** (`message_sent` in `group_events` or not) and **client data**
(TanStack Query or a feature hook).

## Decision
**Table `public.group_messages` (M18)**
- `id bigint GENERATED ALWAYS AS IDENTITY` PK; `group_id uuid` FK groups
  ON DELETE CASCADE (only the solo-group `delete_group` path reaches it);
  `sender_id uuid` FK profiles ON DELETE RESTRICT (profiles are tombstoned);
  `body text` 1–2000 characters, trimmed, no control characters except
  `\n`/`\t`; `client_request_id uuid NOT NULL`, UNIQUE
  `(group_id, sender_id, client_request_id)`; `created_at timestamptz` set
  by the RPC to `clock_timestamp()` after its locks.
- Indexes `(group_id, created_at DESC, id DESC)` (paging) and
  `(sender_id, created_at DESC)` (rate limit). Order `(created_at, id)`.
- No `kind` column (candidates are their own table in Phase 7). No edit,
  delete, reactions, threads or attachments. A guard trigger refuses UPDATE,
  and DELETE unless the group row is already gone (the cascade).

**Write path: `send_group_message(p_group_id, p_body, p_client_request_id)
RETURNS public.group_messages`**, SECURITY DEFINER, `search_path=''`,
EXECUTE for `authenticated` only. Steps in order: (1) no session →
`auth_required`; (2) not an active member → `not_found_or_forbidden`;
(3) trim and validate the body (`invalid_body`), null request id →
`invalid_request`; (4) lock the caller's active membership row `FOR SHARE`
and re-check (serialises with leave/remove/account deletion); (5)
per-sender advisory lock; (6) idempotency — same (group, sender, request
id) and same body returns the existing row, a different body →
`duplicate_request`; (7) rate limit 20 per 60 s and 1000 per 24 h per
sender across groups (`rate_limited`), idempotent retries not counted;
(8) insert. The sender is always `auth.uid()`. Clients have no write grant.

**Read path.** RLS SELECT for `authenticated` where
`group_id IN (SELECT private.my_active_group_ids())`; `anon` nothing. Former
members (left, removed, deleted account) see nothing; a member added back
sees the whole history. Keyset paging on `(created_at, id)` like
`listActivity` (page 30, max 50, strict cursor validation).
`get_ledger_identities` also references former members who **sent a
message** in the group (per-member probe on the sender index, O(members)),
so former and deleted senders stay nameable. *Amended during
implementation:* the architect's draft referenced every past member, which
would disclose former members with no record and contradicts the operator's
G1 decision (names only for record-referenced users); the harness regression
"former member without ledger rows is not disclosed" caught it.

**Realtime: Postgres Changes.** `ALTER PUBLICATION supabase_realtime ADD
TABLE public.group_messages` in M18; the local harness shim creates an empty
publication so the migration is unconditional, and a structure test checks
membership. Clients subscribe to INSERT only with filter
`group_id=eq.<validated uuid>`; authorization is the SELECT policy, checked
per change, so a removal takes effect from the next message. DELETE events
(solo-group cascade only) are not RLS-filtered but carry only the bigint
PK, and nobody subscribes to them. No Realtime project setting changes.
Reconnect: sending never depends on Realtime; gap-fill on every
`SUBSCRIBED`, on `online` and on tab visibility (fetch the newest page,
merge by id; if it does not overlap, replace and let "Load earlier
messages" recover history). A "Live updates paused — reconnecting" notice
shows while not subscribed.

**Events.** Messages do not write `group_events` (events stay ledger and
membership audit, ADR-0009 condition 1; no feed flooding). Phase 7
candidate decisions do.

**Frontend.** `features/chat/{api,realtime,domain,components}`, mounted by
`app/workspace/sections/ChatSection` at `/groups/:id/chat`. No data
library: ADR-0008 rule 6 does not fire (one mounted view; no unread counts
or cross-view previews — adding those reopens it). A timeline reducer
holds confirmed messages by id sorted by `(created_at, id)`, pending
messages by request id, the older-page cursor and live status. Optimistic
send with a fresh `crypto.randomUUID()`: "Sending…", confirmed by the RPC
result or the realtime row (duplicate dropped by id); failure shows "Not
sent · Retry / Discard" and Retry reuses the request id. Bodies render as
plain text (`pre-wrap`, no HTML/markdown/links). Newest at the bottom
(`role="log"`), explicit "Load earlier messages" keeping scroll position,
auto-scroll only near the bottom or after sending, day separators, sender
("You") and local time, character counter near the limit, Enter sends on
fine pointers (Shift+Enter newline), a Send button always, mobile
full-height layout.

## Consequences
M18 adds one table, one RPC, a replaced `get_ledger_identities` and a
publication change to the next production batch. Chat content is permanent.

## Risks
- Postgres Changes throughput is bounded by per-subscriber checks; fine at
  this scale, move to (3) through a new ADR if needed.
- Messages cannot be retracted and survive account deletion; bodies may
  hold personal data (product/privacy trade-off, flagged for operator
  confirmation before production).
- The rehearsal must prove Realtime evaluates `private.my_active_group_ids()`
  under the subscriber's JWT, including after a token refresh.
- `bigint` ids reveal overall message volume (as `group_events` ids do).
- Production's publication might be `FOR ALL TABLES` or non-empty; the
  batch pre-checks it.

## Binding conditions
1. One migration (M18) in house style (`SET LOCAL lock_timeout`, REVOKE ALL
   then explicit GRANTs, `search_path=''`, header, rollback note; fix-forward
   once production has messages).
2. Table CHECKs enforce the body rules; the RPC validates too.
3. `authenticated`: SELECT on the table, EXECUTE on the RPC only; `anon`
   nothing; no client INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER.
4. RPC step order exactly as above; idempotency before the rate limit.
5. Guard trigger refuses UPDATE and non-cascade DELETE; `delete_group` still
   works for a solo group with messages.
6. `get_ledger_identities` only gains the message-sender branch (G1 kept:
   former members with no record stay undisclosed) and still refuses
   outsiders.
7. No `group_events` writes from chat (tested).
8. Shim creates an empty `supabase_realtime` publication; a structure test
   checks the table is published.
9. Harness cases: send/read; two-group isolation; outsider read 0 rows and
   send refused; left/removed/account-deleted refused for read and send;
   re-added member reads full history; anon denied; direct INSERT denied;
   body boundaries (blank, whitespace, 2000 ok, 2001, control chars, trim);
   null request id; idempotency (same body same row, different body
   `duplicate_request`); keyset paging over tied timestamps; 21st send in a
   minute refused and retries not counted; concurrent sends cannot exceed
   the limit; send vs remove/leave waits then is refused; former/deleted
   sender nameable.
10. Client validates `groupId` as a UUID before any Realtime filter or query;
    cursors validated like `isValidCursor` (moved to `shared/api`).
11. `features/chat/realtime/subscribeGroupMessages(groupId, onEvent): () =>
    void`, INSERT only, payloads parsed strictly (a bad row triggers a
    gap-fill), unknown senders trigger name re-resolution.
12. Error codes `invalid_body`, `invalid_request` (validation) and
    `rate_limited` mapped; chat supplies its own text for
    `duplicate_request` (the shared text is about payments).
13. SplitChat-Dev checks with real users: member A sends, member B receives
    exactly one INSERT and reads it; outsider (with and without filter),
    former member and anon receive nothing; after B's removal the next
    message does not reach B; B still receives after a JWT refresh;
    outsider SELECT is empty and the RPC refuses.
14. Production batch pre-checks the `supabase_realtime` publication before
    and after M18.
15. Security review covers the RPC, the policy, the identities change and
    the Realtime proof.
