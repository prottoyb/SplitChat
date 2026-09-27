-- Shim self-test: the role attributes must match production
-- (supabase/baseline/catalog_inventory.txt §11). Fails loudly on drift.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('anon',          false, false, false, true),
      ('authenticated', false, false, false, true),
      ('service_role',  false, true,  false, true),
      ('authenticator', false, false, true,  false),
      ('postgres',      false, true,  true,  true)
    ) AS e(rolname, super, bypassrls, canlogin, inherit)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_roles p
      WHERE p.rolname = r.rolname AND p.rolsuper = r.super
        AND p.rolbypassrls = r.bypassrls AND p.rolcanlogin = r.canlogin
        AND p.rolinherit = r.inherit
    ) THEN
      RAISE EXCEPTION 'shim self-test: role % does not match production attributes', r.rolname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_auth_members am
        JOIN pg_roles m ON m.oid = am.member AND m.rolname = 'authenticator'
        JOIN pg_roles g ON g.oid = am.roleid
       WHERE g.rolname IN ('anon', 'authenticated', 'service_role')) <> 3 THEN
    RAISE EXCEPTION 'shim self-test: authenticator memberships differ from production';
  END IF;
  RAISE NOTICE 'ok: shim roles match production inventory';
END
$$;
