\set ON_ERROR_STOP on

-- Run only in an authenticated administrative psql session. Passwords are
-- intentionally absent; set each new login interactively with \password.
DO $bootstrap$
DECLARE
  role_name text;
  attributes record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
    RAISE EXCEPTION 'Provider runtime role bootstrap requires an authenticated PostgreSQL administrator';
  END IF;

  FOREACH role_name IN ARRAY ARRAY['rotamoto_provider_resolver','rotamoto_provider_worker'] LOOP
    SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin,rolinherit
      INTO attributes FROM pg_roles WHERE rolname=role_name;
    IF NOT FOUND THEN
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',role_name);
    ELSIF attributes.rolsuper OR attributes.rolcreatedb OR attributes.rolcreaterole OR attributes.rolreplication OR
      attributes.rolbypassrls OR NOT attributes.rolcanlogin OR attributes.rolinherit THEN
      RAISE EXCEPTION 'Existing provider runtime role % has unexpected attributes; investigate instead of broadening or silently repairing it',role_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles member_role ON member_role.oid=m.member
    JOIN pg_roles granted_role ON granted_role.oid=m.roleid
    WHERE member_role.rolname IN ('rotamoto_provider_resolver','rotamoto_provider_worker')
       OR granted_role.rolname IN ('rotamoto_provider_resolver','rotamoto_provider_worker')
  ) THEN
    RAISE EXCEPTION 'Provider runtime role membership exists; review inherited privileges before continuing';
  END IF;
END
$bootstrap$;
