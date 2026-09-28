-- Rollback of M24 (group details). Drops the owner rename RPC and restores
-- the M17 event kinds. Fails while group_updated events exist (the event log
-- is immutable): once groups have been renamed in production, treat M24 as
-- fix-forward (a rollback needs its own approval).

DROP FUNCTION public.update_group_details(uuid, text, text, timestamptz);

ALTER TABLE public.group_events DROP CONSTRAINT group_events_kind_check;
ALTER TABLE public.group_events ADD CONSTRAINT group_events_kind_check CHECK (kind IN ('group_created', 'member_added', 'member_rejoined', 'member_left', 'member_removed', 'member_account_deleted', 'ownership_transferred', 'expense_created', 'expense_updated', 'expense_deleted', 'settlement_recorded', 'settlement_voided'));
