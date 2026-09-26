# Production batch 2 (M6–M10): implementation and rehearsal evidence

**Scope:** M6–M10 (design §B) plus the frontend changes that must ship with
them. **Production:** unchanged; batch 2 has not been applied. **Rehearsed
on:** SplitChat-Dev (`opviwtyfssxoheigflxw`), synthetic data only.

## Migrations

| # | File | SHA-256 | What it does |
|---|---|---|---|
| M6 | `20260926150000_least_privilege_grants.sql` | `d1f1c66a…324f14` | Least-privilege grants (below); default privileges stop auto-granting new objects |
| M7 | `20260926160000_membership_lifecycle_and_single_owner.sql` | `9825e7fc…a17a` | Membership history (`left_at`, `left_reason`, `removed_by`); one active owner per group; group identity guard |
| M8 | `20260926170000_private_helpers_rls_rewrite.sql` | `42863e08…46fc` | Private helpers; RLS on active membership; `get_ledger_identities`; exposed helpers dropped; trigger functions moved to `private` |
| M9 | `20260926180000_membership_rpcs.sql` | `460931bf…fe86` | Authorization-first membership RPCs; hardened add-by-email |
| M10 | `20260926190000_revoke_direct_membership_delete.sql` | `4b702e55…ecddb` | Removes the last direct membership write path |

Full digests are pinned in `scripts/ops/prod.mjs` (`BATCHES.batch2`),
together with the pre-state schema (`supabase/ops/batch1_expected_schema.sql`)
and the post-state schema (`supabase/ops/batch2_expected_schema.sql`,
SHA-256 `52d45db9…acd6`). Every file begins with
`SET LOCAL lock_timeout = '5s'`.

**M6 (least-privilege grants):**

- anon: no table privileges;
- authenticated: SELECT on all tables (RLS applies),
  `INSERT(name, description, created_by)` on groups,
  `UPDATE(full_name, avatar_url)` on profiles;
- no TRUNCATE/REFERENCES/TRIGGER for client roles;
- owner direct member-insert and group update/delete removed.

**M8 (private helpers and RLS):**

- `private` schema: only `authenticated` has USAGE, and only for the
  caller-scoped RLS helpers;
- internal membership checks have no client EXECUTE;
- RLS is set-based and uses active membership only: former members lose
  access, there is no former-member directory, and profiles are visible
  for self plus active peers;
- `get_ledger_identities` returns names only for ledger-referenced former
  or deleted users (G1);
- exposed helpers dropped: `split_chat_is_group_member`,
  `is_group_member`, `is_group_owner`, `shares_group_with`;
- trigger functions moved to `private`.

**M9 (membership RPCs):**

- **Add-by-email:**
  - checks the caller is the owner before anything else;
  - returns `added`, `already_member`, `member_not_added` or
    `rate_limited`, rather than raising;
  - "no account" and "unconfirmed" are the same outcome;
  - discloses identity only on `added`;
  - rate limit of 20 per hour, counting every attempt (successful or
    not), serialised per caller with an advisory lock (B2-QS-1);
  - re-adding a former member reactivates the row.
- **New RPCs:** `remove_group_member`, `leave_group` (an owner must
  transfer first) and `transfer_group_ownership` (demote then promote,
  under row locks).

### Implementation findings (differences from the design text)

1. **`handle_new_user` is moved, not recreated (M8).** `postgres` does not
   own `auth.users` (the table is platform-owned), so it cannot drop or
   recreate triggers there. The harness caught this. M8 moves the function
   with `ALTER FUNCTION … SET SCHEMA private`, which keeps the same OID, so
   the trigger stays bound. There is **no DDL on `auth.users`** in batch 2.
   Proven on SplitChat-Dev: GoTrue sign-up still creates the profile.
2. **Test databases are owned by `postgres` (harness).** This matches
   production, where `postgres` owns the database and can create in
   `public`.
3. **`prod.mjs` is generalised to reviewed batches** (`--batch batch1|batch2`).
   Batch 1 behaviour is unchanged. Batch 2 adds:
   - an exact pre-state schema and migration-history precondition;
   - Q9/Q10 pre-checks;
   - 22 named post-checks;
   - its own approval token.

## Frontend compatibility (must ship with M9/M10)

The new frontend lives in commits `2919523` (and the M9/M10 DB commits
alongside it).

- `src/lib/membershipApi.ts`: typed RPC wrappers.
- `src/lib/rpcErrors.ts`: error codes mapped to text; raw messages are
  never shown.
- `GroupDetailsPage`:
  - ownership comes from the membership **role**, not `created_by`;
  - remove and leave go through the RPCs;
  - add-member messages don't disclose whether an account exists;
  - a "Make owner" action with confirmation;
  - owners are told to transfer before leaving.
- `GroupsPage`: the owner badge comes from the role.
- Expense pages: former members' display names come from
  `get_ledger_identities`.

**Old-frontend behaviour against each migration:**

- **M6–M8:** fully compatible with the old frontend.
- **M9:** changes the add-by-email contract. An old frontend would show
  "Member added" even for `member_not_added`, and would still use
  `created_by` as the owner after a transfer.
- **M10:** removes direct deletes, so an old frontend's leave/remove would
  fail.

**Required production ordering:** no hosted frontend exists (G5), so the
frontend in use must be at `2919523` or later whenever M9 and M10 are live.

## Local evidence (Tier 1)

- lint ✅, build ✅, `npm test` ✅ 9 files / 117 tests (33 new).
- `npm audit` ✅ 0.
- `test:db` ✅: baseline round-trip, **10/10** rollback up/down/up checks,
  17/17 cases, 180 assertions. New cases:
  - 130 (M6);
  - 140 (M7);
  - 150 (M8, including the S9 differential and G1);
  - 160 (M9: every role, outcome, differential and the rate limit).

  Cases 010, 020, 080, 100, 110 and 121 were updated to the new contract.

## SplitChat-Dev rehearsal (Tier 2)

**Dress rehearsal of the exact production tool**
(`prod.mjs --batch batch2 --rehearse-on-dev`):

| Step | Result |
|---|---|
| Scenario prepared with the *pre-batch* API (as production is today) | a group with owner, 2 members, one expense |
| `preflight` | **6/6 PASS**: exact pre-state schema, history = M0..M5, Q9/Q10/Q4/Q5 = 0, ledger snapshot, locks 0/0 |
| `push` with no approval / the batch1 token / batch1 `repair-m0` | all refused |
| `dry-run` | exactly M6–M10 |
| `push` (approved token) | M6 → M10 applied |
| `push` again | refused (history is no longer M0..M5) |
| `verify` | **VERIFY PASSED**: history M0..M10, **22/22** named post-checks, ledger unchanged, schema == reviewed post-M10 schema |

**Real-API checks (first rehearsal; see the re-rehearsal below for the final 44/44):** `scripts/rehearsal/api-batch2.mjs verify`,
**43/43 PASS**. Areas covered:

- **anon:** no reads, no RPCs. The old oracle returns 404 for anon and
  signed-in users alike. Private helpers are not reachable through the
  Data API.
- **Differential oracle (S9):** an outsider or member gets byte-identical
  `not_found_or_forbidden` for existing vs nonexistent groups, members,
  transfer targets and emails.
- **Owner add-by-email:**
  - added, with the name;
  - `already_member` with no identity;
  - no-account ≡ unconfirmed;
  - `invalid_email`.
- **Direct writes:** membership insert/delete, group update/delete and
  protected profile columns are all refused. Display-name updates and
  group creation still work.
- **Remove / leave:**
  - access is lost afterwards;
  - former members see nothing and cannot read ledger identities;
  - historical splits stay visible to members;
  - no former-member directory;
  - `get_ledger_identities` returns name only;
  - a former member cannot be a new participant.
- **Transfer:**
  - owner leave → `owner_must_transfer`;
  - transfer to a former member refused;
  - transfer to an active member, after which the old owner can leave;
  - exactly one owner remains.
- **Re-add:** a former member is re-added, regains access and can create
  an expense.

**GoTrue:** sign-up through the Auth admin API still creates the profile
after M8 (the function was moved). A probe user was deleted afterwards.

## Review round 1 and resolutions

Three reviews, none with CRITICAL or HIGH findings:

- QA/Security (SQL): PASS.
- QA/Security (tooling + frontend): PASS.
- Senior: APPROVE WITH CONDITIONS.

| Finding | Severity | Resolution |
|---|---|---|
| B2-QS-1: the rate limiter's count-then-insert could be bypassed by concurrent calls | MEDIUM | **M9 amended** before any production use: `pg_advisory_xact_lock` per caller serialises the check. Proven on SplitChat-Dev: 30 concurrent attempts from one owner give **exactly 20 answered and 10 `rate_limited`**. The harness also pins the lock. M9's SHA-256 is now `460931bf…fe86` and the expected schema `52d45db9…acd6` |
| B2-QS-2: the budget is per caller across all their groups | LOW / info | Intended: the anti-enumeration budget is per person. Documented |
| B2-SR-3: the frontend ordering requirement was documentation only | MEDIUM | `prod.mjs push --batch batch2` now **requires** `SPLITCHAT_FRONTEND_ATTESTATION`. It must be either the live frontend commit (verified with git to contain `2919523`) or exactly `no-live-frontend`, and it is echoed into the push log. Tested: a missing, malformed or pre-M9 commit is refused |
| B2-SR-1: removed/transferred rows stay briefly actionable during the reload | LOW | The member list updates immediately after a successful remove or transfer; tested |
| B2-SR-2: wording said the limit counts "failures" | LOW | Docs say "every attempt"; the M9 header was updated |
| B2-QT-1: no tests for the GroupsPage owner badge or the expense-page former-member names | LOW | Added `GroupsPage.test.tsx` and `ExpenseDetailsPage.test.tsx` (ledger name, fallback, no RPC when not needed) |
| B2-QT-2: `already_member` / `rate_limited` not tested at page level | LOW | Page tests added |
| B2-QT-3: duplicate `--batch` accepted; batch 1 baseline not hash-pinned | LOW | Exactly one `--batch` is required; the Phase 0 baseline is pinned (`7d4971e0…9d9d`) |

## Re-rehearsal with the amended M9 (SplitChat-Dev)

1. **Reset to the exact post-M5 state.**
   - The five reviewed rollbacks (M10 → M6) all ran cleanly **on real
     Supabase**.
   - History rows reverted.
   - ACL entry order restored.
   - Exact comparison with the post-M5 schema: IDENTICAL.
2. **First re-run: pre-flight ABORT on Q10 = 1.** The earlier rehearsal's
   ownership transfer left one synthetic group whose owner was not its
   creator once M7 was rolled back. This is exactly the condition Q10
   guards against. My rehearsal chain then continued past the ABORT;
   the production procedure stops at any ABORT. The synthetic roles were
   corrected and the rehearsal was rerun with stop-on-abort chaining.
3. **Clean run** (`prepare` → `preflight` → `dry-run` → `push` with the
   approval token and frontend attestation → `verify`):
   - pre-flight **6/6 PASS**;
   - `dry-run` listed exactly M6–M10;
   - M6–M10 applied;
   - **VERIFY PASSED**: history M0..M10, **22/22** named post-checks,
     ledger unchanged, schema == the reviewed post-M10 schema.
4. **Real-API checks: 44/44 PASS.**
   - The script is now re-runnable: fresh owner and limiter users per
     run. It was run three times.
   - One earlier failure was a flaw in the test itself: Bob and Eve are
     legitimately active co-members of an older rehearsal group. The
     "no former-member directory" check now uses a user whose only group
     was the one they left.
5. **GoTrue:** sign-up still creates the profile.

## Rollback / recovery for batch 2

- Each migration has a reviewed rollback (`supabase/rollbacks/`) that
  restores the previous schema exactly (harness up/down/up).
- **Semantic limit:** once any member has left or been removed, rolling
  back **M7 or M8** would make former members count as active again, and
  M7's rollback would also discard membership history. After real
  leave/remove activity, recovery is **fix-forward only**.
- M6, M9 and M10 rollbacks remain safe.
- A failure mid-push leaves earlier files applied and the failing file
  fully rolled back (proven in the batch 1 rehearsal); stop and assess.
- Locks: brief DDL locks on `group_members`, `groups`, `profiles`,
  `expenses` and `expense_splits`. Each file has
  `SET LOCAL lock_timeout = '5s'`, so a blocked file fails fast and rolls
  back instead of queueing.

## Residual behaviour after M10

- Add-by-email still confirms existence to an **owner** for accounts that
  are then added (by design: owner-only, rate-limited, confirmed accounts
  only). Invitations remain out of scope.
- Owner account deletion is still refused with an Auth 500, and a member
  with ledger history still cannot be deleted. **M11** fixes both.
- No sole-member group deletion yet (**M15**).
- No rename/description edit for groups (not a current feature).
- Remainder-cent order mismatch between the preview and the RPC (**M12**).
- The expense RPC still returns raw human-readable error messages
  (legacy); these are mapped when M12 introduces v2.
