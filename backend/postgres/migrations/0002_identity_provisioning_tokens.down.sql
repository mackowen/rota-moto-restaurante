SET LOCAL row_security = off;

DO $$
DECLARE row_count bigint;
BEGIN
  SELECT count(*) FROM rotamoto.identity_tokens INTO row_count;
  IF row_count > 0 THEN
    RAISE EXCEPTION 'rollback bloqueado: rotamoto.identity_tokens contém dados';
  END IF;
  SELECT count(*) FROM rotamoto.provisioning_requests INTO row_count;
  IF row_count > 0 THEN
    RAISE EXCEPTION 'rollback bloqueado: rotamoto.provisioning_requests contém dados';
  END IF;
END $$;

DROP TABLE rotamoto.identity_tokens;
DROP TABLE rotamoto.provisioning_requests;
DELETE FROM rotamoto.permissions WHERE catalog_version = 1 AND permission_key IN (
  'company.manage','members.invite','members.read','orders.read','orders.manage','integrations.manage'
);
