-- Production batch 5 (M24-M25, Phase 9) read-only pre-checks. Aggregate
-- counts only. Runs inside the asserted read-only transaction
-- (scripts/ops/prod.mjs). Zero-checks: Q4, Q5, Q23-Q28 (listed in prod.mjs).
--
-- Q4/Q5: ledger balanced (M4 invariants) before any change.
-- Q23: the M25 compatibility check (ADR-0013). Live profiles whose name
--   breaks the new rule. M25 adds its CHECK NOT VALID, so such rows would not
--   make the push fail, but the release requires 0: a non-zero count stops
--   the release for an assessment. The tool never changes these rows;
--   renaming anyone in production is a data change with its own approval.
-- Q24/Q25: M24/M25 objects must not exist yet (no partial or hand-made
--   earlier version; the push would fail or leave an unreviewed object).
-- Q26: every existing activity event already satisfies the kind list M24
--   installs (M24 drops and re-adds group_events_kind_check, validated).
-- Q27: clients still have no direct write path to group details: no UPDATE
--   privilege (table or column) for anon/authenticated/PUBLIC on
--   public.groups and no UPDATE policy on it (M6). M24's RPC must stay the
--   only path.
-- Q28: M24/M25 prerequisites present: private.is_active_owner_of,
--   private.record_group_event (M16 signature), private.handle_new_user,
--   the enabled on_auth_user_created trigger bound to it,
--   groups.updated_at, group_events_kind_check, and profiles.full_name
--   NOT NULL (the M25 rule relies on it).
-- info rows: counts for the evidence package.

SELECT 'Q4 expenses whose splits do not sum to the amount' AS check, count(*) AS value
  FROM public.expenses e
 WHERE e.amount <> (SELECT coalesce(sum(s.share_amount), 0)
                      FROM public.expense_splits s WHERE s.expense_id = e.id)
UNION ALL
SELECT 'Q5 expenses with no splits', count(*)
  FROM public.expenses e
 WHERE NOT EXISTS (SELECT 1 FROM public.expense_splits s WHERE s.expense_id = e.id)
UNION ALL
SELECT 'Q23 live profiles breaking the M25 display-name rule', count(*)
  FROM public.profiles
 WHERE deleted_at IS NULL
   AND NOT (
     full_name = btrim(full_name)
     AND char_length(full_name) BETWEEN 1 AND 80
     AND lower(regexp_replace(full_name, '\s+', ' ', 'g')) <> 'deleted user'
   )
UNION ALL
SELECT 'Q24 update_group_details already exists (any signature)', count(*)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('public', 'private') AND p.proname = 'update_group_details'
UNION ALL
SELECT 'Q25 profiles_full_name_check already exists', count(*)
  FROM pg_constraint WHERE conrelid = 'public.profiles'::regclass AND conname = 'profiles_full_name_check'
UNION ALL
SELECT 'Q26 activity events outside the M24 kind list', count(*)
  FROM public.group_events
 WHERE kind NOT IN ('group_created', 'member_added', 'member_rejoined', 'member_left', 'member_removed',
                    'member_account_deleted', 'ownership_transferred', 'expense_created', 'expense_updated',
                    'expense_deleted', 'settlement_recorded', 'settlement_voided', 'group_updated')
UNION ALL
SELECT 'Q27 direct client UPDATE paths on public.groups', count(*)
  FROM (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'groups' AND privilege_type = 'UPDATE'
       AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    UNION ALL
    SELECT 1 FROM information_schema.column_privileges
     WHERE table_schema = 'public' AND table_name = 'groups' AND privilege_type = 'UPDATE'
       AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    UNION ALL
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'groups' AND cmd IN ('UPDATE', 'ALL')
    UNION ALL
    -- Effective privileges, whoever granted them (information_schema shows
    -- only grants visible to the current role).
    SELECT 1 FROM (VALUES ('anon'), ('authenticated'), ('public')) r(role)
     WHERE has_any_column_privilege(r.role, 'public.groups', 'UPDATE')
  ) x
UNION ALL
SELECT 'Q28 missing M24/M25 prerequisites', count(*)
  FROM (VALUES
    (to_regprocedure('private.is_active_owner_of(uuid,uuid)') IS NOT NULL),
    (to_regprocedure('private.record_group_event(uuid,uuid,text,uuid,uuid,uuid[],jsonb)') IS NOT NULL),
    (to_regprocedure('private.handle_new_user()') IS NOT NULL),
    (EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'auth.users'::regclass AND tgname = 'on_auth_user_created'
                AND tgenabled <> 'D' AND tgfoid = to_regprocedure('private.handle_new_user()'))),
    (EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.groups'::regclass AND attname = 'updated_at' AND NOT attisdropped)),
    (EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.group_events'::regclass AND conname = 'group_events_kind_check')),
    (EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.profiles'::regclass AND attname = 'full_name' AND attnotnull))
  ) AS prerequisites(present)
 WHERE NOT present
UNION ALL
SELECT 'info: live profiles', count(*) FROM public.profiles WHERE deleted_at IS NULL
UNION ALL
SELECT 'info: tombstoned profiles (exempt from M25)', count(*) FROM public.profiles WHERE deleted_at IS NOT NULL
UNION ALL
SELECT 'info: groups (M24 changes none)', count(*) FROM public.groups
UNION ALL
SELECT 'info: activity events', count(*) FROM public.group_events;
