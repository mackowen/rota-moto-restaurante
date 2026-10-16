DO $rollback$
BEGIN
  IF EXISTS (SELECT 1 FROM rotamoto.installation_bootstrap WHERE completed_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM rotamoto.bootstrap_authorizations) THEN
    RAISE EXCEPTION 'rollback blocked: bootstrap history exists; use a reviewed forward migration';
  END IF;
END;
$rollback$;
DROP TABLE rotamoto.bootstrap_authorizations;
DROP TABLE rotamoto.installation_bootstrap;
