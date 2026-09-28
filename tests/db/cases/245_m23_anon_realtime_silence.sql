-- M23: anon may SELECT the two Realtime-published tables only so that RLS
-- (not a permission error) decides; the RESTRICTIVE policy guarantees anon
-- sees no row even if a permissive policy for anon is added later by mistake
-- (QA/Security request, Phase 8).

SELECT tests.assert(has_table_privilege('anon', 'public.group_messages', 'SELECT')
                    AND has_table_privilege('anon', 'public.expense_candidates', 'SELECT'),
  'anon holds SELECT on exactly the published tables');
SELECT tests.assert(NOT EXISTS (SELECT 1 FROM pg_class c
    CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
    WHERE c.relnamespace = 'public'::regnamespace AND c.oid IN ('public.group_messages'::regclass, 'public.expense_candidates'::regclass)
      AND has_table_privilege('anon', c.oid, p)),
  'and nothing else on them');

BEGIN;
-- Rows exist in both tables.
SELECT tests.login('00000000-0000-4000-8000-00000000000b');
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE m AS SELECT (public.send_group_message('10000000-0000-4000-8000-000000000001', 'hello', gen_random_uuid())).id AS id;
SELECT public.propose_expense_candidate((SELECT id FROM m), 'manual', 't', NULL, NULL, current_date, NULL, NULL);
RESET ROLE;
-- A careless future policy that would open both tables to anon:
CREATE POLICY "mistake" ON public.group_messages FOR SELECT TO anon USING (true);
CREATE POLICY "mistake" ON public.expense_candidates FOR SELECT TO anon USING (true);
SELECT tests.logout();
SET LOCAL ROLE anon;
SELECT tests.assert_eq((SELECT count(*) FROM public.group_messages), 0::bigint, 'anon still reads no message: the restrictive policy wins');
SELECT tests.assert_eq((SELECT count(*) FROM public.expense_candidates), 0::bigint, 'anon still reads no proposal');
RESET ROLE;
ROLLBACK;
