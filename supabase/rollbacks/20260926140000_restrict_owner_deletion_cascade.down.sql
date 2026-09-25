-- Rollback of M5. NOT ADVISED: restores the cascade that lets an owner's
-- account deletion destroy other members' ledger (QS-4). Recovery only; in
-- production apply as a new forward migration under its own approval.
ALTER TABLE public.groups DROP CONSTRAINT groups_created_by_fkey;
ALTER TABLE public.groups
  ADD CONSTRAINT groups_created_by_fkey FOREIGN KEY (created_by)
  REFERENCES auth.users(id) ON DELETE CASCADE;
