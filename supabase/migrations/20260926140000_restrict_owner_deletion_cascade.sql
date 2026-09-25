-- M5: deleting a group owner's account can no longer cascade away the group
-- and every member's ledger (QS-4 HIGH, interim). Design:
-- docs/phase1/design.md §A5, §B M5 · ADR-0005.
--
-- Until M11 introduces ledger-preserving account deletion, deleting an
-- account that created a group fails with a foreign-key violation instead of
-- destroying other people's data.
--
-- Production pre-check Q8: groups whose created_by has no auth user = 0.

ALTER TABLE public.groups DROP CONSTRAINT groups_created_by_fkey;
ALTER TABLE public.groups
  ADD CONSTRAINT groups_created_by_fkey FOREIGN KEY (created_by)
  REFERENCES auth.users(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.groups VALIDATE CONSTRAINT groups_created_by_fkey;
