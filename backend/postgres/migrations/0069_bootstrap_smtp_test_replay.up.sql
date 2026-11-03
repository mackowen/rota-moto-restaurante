-- Track SMTP test submissions under the temporary first-install capability.
-- SMTP credentials and settings remain outside PostgreSQL.
CREATE TABLE IF NOT EXISTS rotamoto.bootstrap_smtp_test_attempts (
  authorization_digest bytea NOT NULL CHECK (octet_length(authorization_digest)=32),
  request_id uuid NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (authorization_digest, request_id)
);
CREATE TABLE IF NOT EXISTS rotamoto.platform_smtp_test_attempts (
  user_id uuid NOT NULL,
  request_id uuid NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);

ALTER TABLE rotamoto.bootstrap_smtp_test_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.bootstrap_smtp_test_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bootstrap_smtp_test_attempts_migrator ON rotamoto.bootstrap_smtp_test_attempts;
CREATE POLICY bootstrap_smtp_test_attempts_migrator ON rotamoto.bootstrap_smtp_test_attempts
  FOR ALL TO rotamoto_migrator USING (true) WITH CHECK (true);
ALTER TABLE rotamoto.platform_smtp_test_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.platform_smtp_test_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_smtp_test_attempts_migrator ON rotamoto.platform_smtp_test_attempts;
CREATE POLICY platform_smtp_test_attempts_migrator ON rotamoto.platform_smtp_test_attempts
  FOR ALL TO rotamoto_migrator USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE rotamoto.bootstrap_smtp_test_attempts,rotamoto.platform_smtp_test_attempts FROM PUBLIC, rotamoto_app, rotamoto_e2e_app;

CREATE OR REPLACE FUNCTION rotamoto.platform_admin_record_bootstrap_smtp_test(
  target_authorization_digest bytea, target_request_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
DECLARE inserted integer;
BEGIN
  IF session_user <> 'rotamoto_app' OR current_database() <> 'rotamoto' OR
     octet_length(target_authorization_digest) IS DISTINCT FROM 32 OR target_request_id IS NULL THEN
    RETURN false;
  END IF;
  IF rotamoto.platform_admin_bootstrap_status() <> 'ready' THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(encode(target_authorization_digest,'hex'), 6901));
  PERFORM 1 FROM rotamoto.bootstrap_authorizations
    WHERE token_digest=target_authorization_digest AND installation_scope='rotamoto'
      AND consumed_at IS NULL AND expires_at>now() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF (SELECT count(*) FROM rotamoto.bootstrap_smtp_test_attempts
      WHERE authorization_digest=target_authorization_digest AND attempted_at>now()-interval '15 minutes') >= 5 THEN
    RETURN false;
  END IF;
  INSERT INTO rotamoto.bootstrap_smtp_test_attempts(authorization_digest,request_id)
    VALUES(target_authorization_digest,target_request_id) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted=1;
END $$;
REVOKE ALL ON FUNCTION rotamoto.platform_admin_record_bootstrap_smtp_test(bytea,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotamoto.platform_admin_record_bootstrap_smtp_test(bytea,uuid) TO rotamoto_app;

CREATE OR REPLACE FUNCTION rotamoto.platform_admin_record_smtp_admin_test(target_user uuid, target_request_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
DECLARE inserted integer;
BEGIN
  IF session_user <> 'rotamoto_app' OR current_database() <> 'rotamoto' OR target_user IS NULL OR target_request_id IS NULL THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(target_user::text, 6902));
  IF NOT EXISTS (SELECT 1 FROM rotamoto.platform_administrators
      WHERE user_id=target_user AND revoked_at IS NULL AND grant_kind='founder_bootstrap') THEN RETURN false; END IF;
  IF (SELECT count(*) FROM rotamoto.platform_smtp_test_attempts
      WHERE user_id=target_user AND attempted_at>now()-interval '15 minutes') >= 5 THEN RETURN false; END IF;
  INSERT INTO rotamoto.platform_smtp_test_attempts(user_id,request_id) VALUES(target_user,target_request_id)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted=1;
END $$;
REVOKE ALL ON FUNCTION rotamoto.platform_admin_record_smtp_admin_test(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotamoto.platform_admin_record_smtp_admin_test(uuid,uuid) TO rotamoto_app;
