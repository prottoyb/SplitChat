SET LOCAL lock_timeout = '5s';

-- M23: anonymous Realtime subscribers learn nothing (Phase 8 security audit).
--
-- Finding (api-security-audit.mjs on SplitChat-Dev): an anonymous client
-- (only the public key) subscribed to group_messages or expense_candidates
-- without a filter received an "Error 401: Unauthorized" notice, with no row
-- data, for every INSERT and UPDATE anywhere: platform-wide activity timing.
-- Authenticated outsiders received nothing, because they hold SELECT and RLS
-- filters every row out; anon held no SELECT, so Realtime reported the
-- denial instead.
--
-- Fix: anon gets SELECT on exactly these two published tables, and a
-- RESTRICTIVE policy that is always false for anon, so RLS returns no row to
-- anon whatever permissive policy may be added later. Anon therefore reads
-- nothing through the API (an empty result instead of a permission error)
-- and receives nothing through Realtime, like an outsider. No other table is
-- published, so no other grant is needed (ADR-0003 otherwise unchanged).
--
-- Rollback: revoke the grants and drop the two policies (safe at any time).

GRANT SELECT ON public.group_messages, public.expense_candidates TO anon;
CREATE POLICY "Anonymous callers see no messages" ON public.group_messages
  AS RESTRICTIVE FOR SELECT TO anon USING (false);
CREATE POLICY "Anonymous callers see no proposals" ON public.expense_candidates
  AS RESTRICTIVE FOR SELECT TO anon USING (false);
