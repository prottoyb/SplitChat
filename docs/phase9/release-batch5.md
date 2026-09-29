# Production release batch 5 (M24–M25): evidence package and runbook

**Status:** prepared and **dress-rehearsed end to end on SplitChat-Dev from a
clean reset (2026-09-29)**. **Not executed.** Production is at M23 (25
versions, batch 4 verified 2026-09-29). Running any write step below needs
the operator's explicit execution approval of batch 5 (Mandatory Gate #5).
Design: ADR-0013.

## Migrations, in order

| # | File | SHA-256 (LF) | Adds | Rollback class |
|---|---|---|---|---|
| M24 | `20261001100000_group_details.sql` | `200c9a177c985f4f5f3ee6602b556e14736faa9231375bd38fdd1ec52826e0bc` | owner-only `update_group_details` RPC (authorize, lock, re-check, optimistic concurrency); `group_updated` event kind | safe until a `group_updated` event exists, then fix-forward (the event log is immutable) |
| M25 | `20261001110000_profile_name_rules.sql` | `746e2a2e9a3cd15a363882656e3b23dda07b62eb4465e8b9a34cdd696288510c` | `profiles_full_name_check` **NOT VALID** (live names trimmed, 1–80, not "Deleted user"; tombstones exempt); sign-up name cleaning in `handle_new_user` | safe rollback any time |

M24 comes first: M25 does not depend on it, but the batch is applied in
timestamp order, like every batch.

## What the tool checks (`scripts/ops/prod.mjs --batch batch5`)

| | Before | After |
|---|---|---|
| Schema (public + private, normalised, exact) | `supabase/ops/batch4_expected_schema.sql` (`c571e828…c46c`) | `supabase/ops/batch5_expected_schema.sql` (`7f285900…462a`), exported from the harness after M25 |
| Migration history | exactly the 25 batch 4 versions | those + M24 + M25 = 27 |
| Ledger snapshot (counts, totals, digests of expenses, splits, groups, memberships, profiles) | recorded | identical |
| Pre-checks (`batch5_prechecks.sql`), all must be 0 | Q4, Q5 ledger balanced; **Q23 M25 compatibility**; Q24 no `update_group_details` yet; Q25 no `profiles_full_name_check` yet; Q26 every event fits the M24 kind list; Q27 no direct client UPDATE path on `groups`; Q28 prerequisites present | — |
| Post-checks (`batch5_postchecks.sql`) | — | 15 named checks, all true |
| Catalog security audit | — | 12 checks, 0 offending rows |
| Writes | `SPLITCHAT_PROD_APPROVAL=batch5` and a frontend attestation (`no-live-frontend`, or a live commit containing `a5ed4e8`) | — |

**Q23, the M25 compatibility check.** This is the operator's read-only
count of live profiles that break the new rule:

```sql
SELECT count(*) FROM public.profiles
 WHERE deleted_at IS NULL
   AND NOT (full_name = btrim(full_name)
            AND char_length(full_name) BETWEEN 1 AND 80
            AND lower(regexp_replace(full_name, '\s+', ' ', 'g')) <> 'deleted user');
```

- **Any non-zero count stops the release.** The tool never changes those
  rows.
- Renaming a production user is a data change, and it needs its own
  approval.
- The constraint stays `NOT VALID`. `VALIDATE CONSTRAINT` is a separate,
  later decision.
- `full_name` is `NOT NULL` (Q28 checks this), so the count needs no NULL
  handling.

**Post-checks:**

1. History is exactly 27 versions.
2. **M24:** `update_group_details(uuid,text,text,timestamptz)` is the only
   function of that name. It returns `timestamptz` and is a plpgsql
   `SECURITY DEFINER` function with an empty `search_path`.
3. **M24:** only `authenticated` (and the owner) may execute it. anon,
   PUBLIC and service_role may not.
4. **M24:** clients have no direct UPDATE path on `groups`: no table or
   column grant, and no UPDATE policy.
5. **M24:** the kind check is validated and allows `group_updated`, and
   clients cannot write to `group_events`.
6. **M25:** the constraint is a `CHECK`, `NOT VALID`, and its expression is
   exactly the reviewed one (the tombstone exemption comes first).
7. **M25:** no live profile breaks the rule.
8. **M25:** `handle_new_user` trims, caps at 80 characters, and falls back
   for blank or reserved sign-up names. It is still `SECURITY DEFINER` with
   an empty `search_path`.
9. **M25:** `on_auth_user_created` is enabled and bound to
   `handle_new_user`.
10. `profiles` grants and RLS are as reviewed:
    - RLS is on.
    - anon has nothing.
    - `authenticated` has SELECT, plus UPDATE of `full_name` and
      `avatar_url` only.
    - The two own/peer policies exist.
11. RLS is on for every table.
12. No function is executable by anon or PUBLIC.
13. Every definer function has an empty `search_path`.
14. The batch 4 anon grants and Realtime publication are unchanged.
15. The ledger is balanced.

**Frontend compatibility.** Batch 5 is additive for every earlier
frontend:

- No existing RPC, grant or policy changes.
- Sign-up names are cleaned rather than refused.

The Phase 9 frontend needs batch 5 first (group rename).

## Evidence

**Local harness:**

| Check | Result |
|---|---|
| The M23 export is byte-identical to the committed `batch4_expected_schema.sql` | pass |
| Applying the M25 and M24 rollbacks returns exactly that schema | pass |
| Pre-checks on the pre-batch state | all 0 |
| Pre-check negatives (padded, blank and reserved live names; UPDATE grant on `groups`; an existing `update_group_details`; a disabled sign-up trigger; an existing constraint) | each flips its own Q |
| Tombstoned "Deleted user" row | not counted by Q23 |
| Post-checks on the post-M25 state | 15/15 |
| Post-check negatives: anon or service_role EXECUTE | caught |
| Post-check negatives: a groups UPDATE grant or policy | caught |
| Post-check negatives: a validated or rewritten constraint | caught |
| Post-check negatives: the M25 rollback | caught |
| Post-check negatives: a disabled trigger | caught |
| Post-check negatives: an extra profiles grant | caught |
| Pre/post-check negatives (review hardening): UPDATE on `groups` or INSERT on `profiles` inherited through a hidden role granted to `authenticated` (invisible to `information_schema`) | caught by the `has_any_column_privilege` / `has_table_privilege` clauses (Q27; M24 and profiles post-checks) |
| Post-check negatives: a reserved live name | caught |
| Post-check negatives: missing history | caught |
| `npm run test:db` | 37/37, 828 assertions |

**CI:** `scripts/ops/manifest.test.mjs` (Vitest) imports the manifest from
`prod.mjs`. That is safe because `prod.mjs` now runs only as a script:
importing it connects to nothing and executes nothing.

The test fails CI if:

- any committed migration or expected schema of any batch stops matching
  its pin;
- a batch's pre-checks lack one of its zero-checks;
- a new migration has not been reviewed into a batch yet.

It also checks that batch5 is exactly M24 and M25 on top of batch 4, and
that its Q23 is the M25 rule applied to live profiles.

**After the review hardening** (read-only on the post-batch-5 Dev):

- The revised post-checks pass 15/15.
- The revised pre-checks run cleanly.
- Q27 is still 0 on real Supabase.

## Dress rehearsal on SplitChat-Dev (2026-09-29)

SplitChat-Dev only (ref `opviwtyfssxoheigflxw`; the sentinel was verified
before every write). Production was not contacted. Synthetic data only.

**Production guards (offline, with no connection attempt).** Every case
below was refused before any network access:

- no `DB_URL`;
- the Dev ref given as production;
- the production ref on a loopback host;
- the production ref on the transaction-pooler port;
- `--batch batch6`;
- `--batch phase9`;
- two `--batch` flags;
- a push without approval.

**Before the reset.** Dev was at 27 versions:

- batch5 `preflight` **refused**: drift, 27 versions, Q24 = Q25 = 1.
- batch5 `verify` passed there (15/15, exact schema). This was the first
  real-Supabase run of the post-checks.

**Reset and replay.** `reset-dev-to-empty.sql` was run in one guarded
transaction, with post-conditions asserted. Then production's path was
replayed with `prod.mjs --rehearse-on-dev`:

| Step | Result |
|---|---|
| M0 | applied directly |
| `api.mjs seed` | done |
| batch 1 | verify **PASSED** 17/17 |
| batch 2 | verify **PASSED** 22/22; API 44/44 |
| batch 3a | verify **PASSED** 24/24; API 36/36 |
| batch 3b | verify **PASSED** 24/24; API 28/28 |
| batch 4 | preflight **PASSED**; verify **PASSED** 13/13; audit **PASSED** |

- Dev was then production's recorded state: 25 versions, schema ==
  `batch4_expected_schema.sql`.
- Data was then added through the current API suites: activity 11/11,
  settlements 19/19, chat 25/25, Smart Expense 23/23, CA-2 26/26.
- The resulting state had 38 live profiles, 6 tombstoned "Deleted user"
  profiles, 19 groups and 86 events.

**Batch 5 (the production procedure):**

| Step | Result |
|---|---|
| `identify` | SplitChat-Dev, 9 public tables, history present |
| Q23 negative: one live synthetic name padded with spaces | `preflight` **ABORT** (Q23 = 1); the name was restored |
| `preflight` | **PREFLIGHT PASSED**: schema exact; 25 versions; Q4, Q5 and Q23–Q28 all 0; 0 locks, 0 long transactions; the 6 tombstones were not counted |
| `dry-run` | exactly `20261001100000_group_details.sql`, `20261001110000_profile_name_rules.sql` |
| `push` refusals: no approval; `batch4` approval; no attestation; attesting `f32b56d` (lacks `a5ed4e8`); an extra migration file between M24 and M25; a batch4 re-push | all **refused**, nothing written |
| `push` (`SPLITCHAT_PROD_APPROVAL=batch5`, `no-live-frontend`) | M24 and M25 applied |
| `push` again | **refused** (history is no longer the batch 5 start) |
| `verify` | **VERIFY PASSED**: 27 versions; 15/15 post-checks; ledger unchanged; schema == `batch5_expected_schema.sql` |
| `audit` | **AUDIT PASSED**: 12 checks, 0 rows |
| `preflight` after the push | correctly **refuses** (drift, 27 versions, Q24 = Q25 = 1) |

**The migrated state:**

| Check | Result |
|---|---|
| Behavioural security audit (anon, outsider, former member; includes `update_group_details`) | **165/165** |
| Activity / settlements / chat / Smart Expense | 11/11, 19/19, 25/25, 23/23 |
| CA-2 (account deletion) | 26/26 |
| Race | 6/6 |
| Accessibility | 30 page views, **0 findings** |
| E2E | **22/23, failing the genuine reset-link journey (reproducible)** |

About the E2E failure:

- Dev Auth redirects the link correctly: a 303 to `/reset-password` with
  `type=recovery` tokens.
- The failure is in the Phase 9 frontend: `ResetPasswordPage` reads
  `isPasswordRecovery()` once, when `getSession()` resolves.
- auth-js emits `PASSWORD_RECOVERY` in a `setTimeout(0)` after
  initialisation, so the page can decide "invalid link" before the event
  and never re-render.
- It is unrelated to batch 5: no Auth code or setting is touched, and the
  rename and display-name journeys pass.
- It **blocks the Phase 9 frontend deployment** until it is fixed on its
  own branch, with QA/Security review.

## Reviews (2026-09-29, independent, on `3253387`)

**QA/Security: PASS**, no CRITICAL, HIGH or MEDIUM.

- The reviewer recomputed the four digests.
- The reviewer checked:
  - that the guards are unchanged;
  - Q23, exactly the operator's query;
  - that missing or NULL rows fail closed;
  - the offline guard refusals.
- LOW findings, all fixed:
  - `deployment.md` read as if batch 5 were done.
  - The runbook's stale batch 4 status.
  - Hardening: use effective-privilege functions alongside
    `information_schema`.

**Senior Review: APPROVE WITH CHANGES**, no CRITICAL or HIGH in the tooling.

- **MEDIUM, fixed:** the manifest test parsed `prod.mjs` as text. `prod.mjs`
  now exports `M` and `BATCHES` and runs `main()` only as a script (the
  guard `db-test.mjs` and `dev.mjs` use). The test imports them and covers
  every batch.
- **LOW, fixed:** the `deployment.md` wording.
- **LOW, fixed:** the runbook title.
- **LOW, fixed:** the PostgreSQL-version pinning of the exact constraint
  text and the `LIKE` fragments is now noted in `batch5_postchecks.sql`.
- **HIGH, outside this change:** the `ResetPasswordPage` race, independently
  confirmed against auth-js 2.112.3.
  - Every genuine reset link shows "invalid or expired".
  - It fails safe: no bypass.
  - It blocks the **Phase 9 frontend release**, not batch 5.
  - It needs its own fix branch with QA/Security review.
  - **Resolved on `fix/password-recovery-race`** (not yet merged); see
    below.

## Reset-link race fix (2026-09-29, `fix/password-recovery-race`)

Frontend only: no database, Auth setting or dependency change. Production is
untouched and the frontend is not deployed.

**Root cause (traced in auth-js 2.112.3 and reproduced on SplitChat-Dev):**

- auth-js `_initialize()` validates the link's tokens (`_getUser`), saves
  the session and returns, which resolves `initializePromise` (and so
  `getSession()`).
- It emits `PASSWORD_RECOVERY` afterwards, in a `setTimeout(0)`.
- `ResetPasswordPage` is lazy-loaded and read the recovery flag once, when
  `getSession()` resolved.
- When the page mounted before Auth finished, it decided "invalid or
  expired" between those two points and never re-checked.
- When the page mounted after the event, it worked, so the failure depended
  on timing.
- A Dev trace with Auth's `/user` call held for 1.5 s: old code 2/2 invalid,
  fix 2/2 form.

**Second defect found while tracing (same class as the Phase 9 CRITICAL):**

- The recovery flag was a module boolean that was never cleared.
- After a reset the page signs out and navigates in-app to `/login`.
- A password sign-in in that same page load could then reopen the reset
  form without the current password.

**Fix:**

- The page subscribes to the recovery event before reading the session.
- Once the session is known, it waits up to 2 s for the event.
- "Checking" is capped at 20 s, and no session means invalid at once.
- Only the event unlocks the form; the URL never does.
- The recovery state is bound to the recovery session's `session_id` claim
  and cleared on sign-out.
- It is not cleared on `SIGNED_IN`, which auth-js re-emits for the same
  session when the tab becomes visible.
- The status text is one live region, and the checking state offers "Back
  to sign in".

**Security model after the fix:**

- The form appears only when the current session is the session named by a
  `PASSWORD_RECOVERY` event on this page load, and there has been no
  sign-out since.
- auth-js emits that event only after the Auth server accepted the link's
  tokens.
- `#type=recovery`, a direct visit, an ordinary session and a later
  sign-in never unlock the form.
- Accepted residual (QA/Security, LOW), unchanged since `8d68eae`:
  - Someone who already holds a valid access token can hand-craft a
    callback URL with that token, or call `updateUser` directly.
  - The server-side control is "Secure password change". Enabling and
    confirming it is part of the production Auth gate (MEDIUM, carried
    over).

**Regression tests:**

- `src/shared/api/supabase.test.ts`: event-only unlock, `session_id`
  binding, surviving same-session `SIGNED_IN`, no stale state after
  sign-out and a new sign-in, and fail-safe on unreadable tokens.
- `src/features/auth/pages/AccountPages.test.tsx`:
  - a late event unlocks the form;
  - an early event unlocks the form;
  - forged hash, direct visit, ordinary session and stale recovery are
    refused;
  - the 20 s cap;
  - an event after "invalid" still unlocks the form;
  - unmount cleanup.
- The race and stale-state tests fail on the old code.
- E2E on Dev (`scripts/e2e/e2e.mjs`, using a new `delays` option in
  `browser.mjs` to force the losing order):
  - a genuine link with slow Auth shows the form, the new password is set,
    and sign-in with it works;
  - an in-app visit after that sign-in offers no form;
  - a used link offers no form, and a fresh one does;
  - direct visits offer no form, signed in or not;
  - a hand-typed `#type=recovery` offers no form.
- `scripts/e2e/a11y.mjs` audits the checking, form and signed-in states.

**Validation (head `d8f7e12`):**

- lint ✅
- build ✅
- Vitest ✅ **658/658** (51 files)
- E2E on Dev ✅ **27/27**
- a11y ✅ 36 page views, **0 findings**
- One earlier E2E run timed out on the Smart Expense proposal (Realtime
  timing, no auth code involved). It passed on the rerun and on the final
  run.

**Reviews (independent):**

- **QA/Security: PASS** on `6a6b474`, re-confirmed on `d8f7e12`, no
  CRITICAL or HIGH.
  - The own-token residual is acceptable, LOW; no client hardening is
    warranted.
  - MEDIUM, carried over: verify "Secure password change" in production.
  - LOW (comment on the decoded claim) fixed; OPTIONAL (held test requests
    not cancelled) accepted.
- **Senior Review: APPROVE** on `6a6b474`, re-confirmed on `d8f7e12`.
  - The HIGH above is **closed**.
  - LOWs fixed: late-event comment and test, unmount test, a11y
    `try/finally`.
  - LOW accepted: signing out in another tab while the form is open leaves
    it displayed; the server rejects the update and the normal error shows.

## Runbook (operator's own PowerShell; `DB_URL` = production session pooler, port 5432)

Before starting:

- Local checkout at the reviewed release commit, with `npm ci` run.
- PostgreSQL 17 client binaries available.
- Recommended: note a backup/PITR point before the push.

```powershell
node scripts/ops/prod.mjs identify --batch batch5
node scripts/ops/prod.mjs preflight --batch batch5 "$env:TEMP\splitchat-evidence\batch5"
node scripts/ops/prod.mjs dry-run --batch batch5
```

**Stop unless the preflight prints `PREFLIGHT PASSED`.** In particular,
Q23 must be 0.

The dry run must list exactly:

- `20261001100000_group_details.sql`
- `20261001110000_profile_name_rules.sql`

Then, **only after explicit execution approval of batch 5:**

```powershell
$env:SPLITCHAT_PROD_APPROVAL = 'batch5'
$env:SPLITCHAT_FRONTEND_ATTESTATION = 'no-live-frontend'   # or the live frontend commit
node scripts/ops/prod.mjs push --batch batch5
Remove-Item Env:SPLITCHAT_PROD_APPROVAL, Env:SPLITCHAT_FRONTEND_ATTESTATION
node scripts/ops/prod.mjs verify --batch batch5 "$env:TEMP\splitchat-evidence\batch5"
node scripts/ops/prod.mjs audit --batch batch5 "$env:TEMP\splitchat-evidence\batch5"
```

`verify` must print `VERIFY PASSED` and `audit` must print `AUDIT PASSED`.

**Smoke tests** (once a Phase 9 frontend exists; with no live frontend,
the catalog checks above are the verification):

- An owner renames a group.
- A member sees the details read-only.
- A display name is edited.
- "Deleted user" is refused as a display name.

### If something fails

| Where | Action |
|---|---|
| Preflight / dry run | Stop. Nothing was written. If Q23 ≠ 0, the affected live names need an approved data decision first; the tool never changes them. |
| Push stops between M24 and M25 | M24 stays applied (each file is atomic). Run `verify` to see the state and assess. Do not re-push blindly: the tool refuses anyway, because the history is no longer the batch 5 start. |
| Verify fails | Stop and assess. Earlier frontends keep working, because the batch is additive. |

### Rollback

- `supabase/rollbacks/20261001110000_profile_name_rules.down.sql` is safe
  at any time.
- `supabase/rollbacks/20261001100000_group_details.down.sql` works only
  while no `group_updated` event exists.
- Any production rollback needs its own execution approval.
