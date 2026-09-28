# ADR-0013: Owner-editable group details and display-name rules

- **Status:** Accepted for SplitChat-Dev (Phase 9, 2026-09-29). Operator
  decision D4 approved the owner rename. **Production is not approved:**
  M24 and M25 need a separate release approval.
- **Migrations:** M24 `20261001100000_group_details`, M25
  `20261001110000_profile_name_rules`.

## Context

M6 (least privilege) removed the direct `UPDATE` grant on `groups` and the
"Owners can update groups" policy, which left no write path for a group's
name or description. A typo in a group name was permanent. Phase 9 also
adds a profile page where people edit their display name. The Phase 8
register had deferred a related issue: anyone could name themselves
"Deleted user" and look like a tombstoned member in shared history.

## Problem

1. Give owners a safe way to rename a group and edit its description.
2. Keep display names meaningful once people can edit them freely.

## Options considered

**Group details**

- (a) Re-grant `UPDATE (name, description)` with an owner RLS policy.
  - Simplest.
  - It is the only direct table write left in the API.
  - It records no activity and has no concurrency control.
  - It reopens a surface M6 deliberately closed.
- (b) **Chosen:** an owner-only `SECURITY DEFINER` RPC,
  `update_group_details`, matching every other write since Phase 1.
- (c) A generic "update group" RPC that also handles membership.
  Rejected as scope creep.

**Display names**

- (a) Validate only in the client. Rejected, because the API is public.
- (b) A plain `CHECK`. It would break account deletion, which writes the
  name "Deleted user", and it would reject existing rows.
- (c) **Chosen:** a `CHECK ... NOT VALID` that exempts tombstoned rows
  (`deleted_at IS NOT NULL`), plus sign-up input cleaning in
  `handle_new_user`.

## Decision

**M24.** `public.update_group_details(p_group_id, p_name, p_description,
p_expected_updated_at) → timestamptz`:

- It checks that the caller is the active owner first. It then locks the
  group row `FOR UPDATE` (the group row first, as every multi-row path
  does since M21) and re-checks ownership under the lock.
- **Optimistic concurrency:** the caller passes the `updated_at` it read.
  A different value raises `stale_group`, and nothing is overwritten.
- **Validation:** the existing table CHECKs are the rules (name 1–80
  characters after trim, description ≤ 300). A blank description is
  stored as NULL. The stable codes are `invalid_name` and
  `invalid_description`.
- An unchanged save is a no-op, with no write and no event.
- **Activity:** a new `group_updated` kind whose payload lists the changed
  field names only, never the text. This keeps the M16 payload-privacy
  rule.
- **Grants:** `EXECUTE` goes to `authenticated` only. Clients still cannot
  `UPDATE groups`.

**M25.** `profiles_full_name_check`:

- The rule: a live profile's name is trimmed, 1–80 characters, and not
  "deleted user" (in any case or spacing).
- It is added `NOT VALID`, so no existing row is read or changed.
- `private.handle_new_user` trims and caps the sign-up name. A blank or
  reserved name falls back to the email's local part, and failing that to
  "SplitChat member". Sign-up never fails because of the name.

## Rationale

- Every write keeps one shape: an RPC that authorizes first, locks and
  re-checks, uses stable error codes and records an event. That shape is
  already covered by the catalog security audit and the RPC allowlists.
- Group owners already have stronger powers (remove members, transfer
  ownership, delete a solo group), so renaming adds no new role or
  permission model.
- `NOT VALID` puts the rule in force for everyone without a production
  data migration.

## Consequences

- There is one more client RPC. The public-function count and the
  allowlists in `tests/db` are updated deliberately.
- Clients read `groups.updated_at`, the version for concurrency.
- The activity feed describes renames ("renamed the group", "changed the
  group description").
- Legacy names that break M25 (for example the blank default) keep
  working until someone edits them.

## Risks

- **Rollback:** M24's rollback fails once `group_updated` events exist,
  because the event log is immutable. Once used in production, M24 is
  fix-forward. M25's rollback is safe at any time.
- **Validating M25 later:** `VALIDATE CONSTRAINT` first needs a read-only
  production count of live profiles that break the rule. If any rows must
  change, that is a production data change and needs its own approval.
- **Reserved-name check:** it catches "deleted user" with any spacing or
  case. It does not catch look-alike Unicode. This is acceptable, because
  tombstones are also marked visually and by `deleted_at` everywhere a
  name is shown.
