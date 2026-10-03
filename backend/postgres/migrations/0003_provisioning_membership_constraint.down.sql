SET LOCAL row_security = off;

DO $$
DECLARE row_count bigint;
BEGIN
  SELECT count(*) FROM rotamoto.provisioning_requests INTO row_count;
  IF row_count > 0 THEN
    RAISE EXCEPTION 'rollback bloqueado: rotamoto.provisioning_requests contém dados';
  END IF;
END $$;

ALTER TABLE rotamoto.provisioning_requests DROP CONSTRAINT provisioning_requests_membership_fk;
