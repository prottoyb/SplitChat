SET LOCAL lock_timeout = '5s';

-- M25: display-name rules (Phase 9, P15; closes the Phase 8 deferred item
-- "a person can set their own display name to 'Deleted user'").
--
-- Phase 9 adds a profile page where people edit their display name. A live
-- profile's name is now trimmed, 1-80 characters, and never "Deleted user",
-- which only account deletion writes (with deleted_at set, M11/M16), so a
-- person cannot pass themselves off as a deleted member in shared history.
--
-- * The CHECK is added NOT VALID: it applies to every insert and update from
--   now on and does not read or change existing rows. Existing names that
--   break it (e.g. blank legacy names) keep working until edited; validating
--   the constraint later needs a read-only data check first and, if rows
--   must change, its own approval.
-- * private.handle_new_user() (the auth.users insert trigger) cleans the
--   sign-up name the same way, falling back to the email's local part, so a
--   reserved, blank or over-long sign-up name never makes sign-up fail.
--   Replaced in place (same OID), as M8 did.
-- No ledger, membership or financial data is touched.
--
-- Rollback: supabase/rollbacks/20261001110000_profile_name_rules.down.sql
-- drops the constraint and restores M8's handle_new_user (safe at any time).

ALTER TABLE public.profiles ADD CONSTRAINT profiles_full_name_check CHECK (
  deleted_at IS NOT NULL OR (
    full_name = btrim(full_name)
    AND char_length(full_name) BETWEEN 1 AND 80
    AND lower(regexp_replace(full_name, '\s+', ' ', 'g')) <> 'deleted user'
  )
) NOT VALID;

CREATE OR REPLACE FUNCTION private.handle_new_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_name text := btrim(left(btrim(coalesce(NEW.raw_user_meta_data ->> 'full_name', '')), 80));
BEGIN
  IF v_name = '' OR lower(regexp_replace(v_name, '\s+', ' ', 'g')) = 'deleted user' THEN
    v_name := btrim(left(split_part(coalesce(NEW.email, ''), '@', 1), 80));
  END IF;
  IF v_name = '' THEN
    v_name := 'SplitChat member';
  END IF;
  INSERT INTO public.profiles (id, full_name)
  VALUES (NEW.id, v_name)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END
$$;
