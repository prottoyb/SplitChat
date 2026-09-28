-- Rollback of M25 (display-name rules): drops the constraint and restores
-- handle_new_user exactly as M8 defined it. Safe at any time.

ALTER TABLE public.profiles DROP CONSTRAINT profiles_full_name_check;

CREATE OR REPLACE FUNCTION private.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (
    NEW.id,
    coalesce(
      nullif(trim(NEW.raw_user_meta_data ->> 'full_name'), ''),
      split_part(coalesce(NEW.email, ''), '@', 1)
    )
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END
$$;
