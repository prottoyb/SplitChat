-- Rollback of M6. Recovery only: restores blanket client privileges
-- (QS-5). In production, apply as a new forward migration under its own
-- approval. Policy text is verbatim from supabase/baseline/public_schema.sql.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated;

CREATE POLICY "Owners can delete groups" ON public.groups FOR DELETE TO authenticated USING (public.is_group_owner(id));
CREATE POLICY "Owners can update groups" ON public.groups FOR UPDATE TO authenticated USING (public.is_group_owner(id)) WITH CHECK ((created_by = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Owners can add group members" ON public.group_members FOR INSERT TO authenticated WITH CHECK ((public.is_group_owner(group_id) AND (role = 'member'::text)));

REVOKE UPDATE (full_name, avatar_url) ON public.profiles FROM authenticated;
REVOKE INSERT (name, description, created_by) ON public.groups FROM authenticated;

GRANT INSERT, UPDATE, TRUNCATE, REFERENCES, TRIGGER ON public.group_members TO authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.groups, public.profiles TO authenticated;
GRANT ALL ON public.profiles TO anon;
