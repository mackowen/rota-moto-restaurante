-- Single-use, short-lived deployment authorization for first-owner bootstrap.
-- The app role receives only the DML required by the guarded provisioning flow.
CREATE TABLE IF NOT EXISTS rotamoto.installation_bootstrap (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  completed_at timestamptz,
  request_digest bytea CHECK (request_digest IS NULL OR octet_length(request_digest)=32),
  CHECK ((completed_at IS NULL) = (request_digest IS NULL))
);

INSERT INTO rotamoto.installation_bootstrap(singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS rotamoto.bootstrap_authorizations (
  token_digest bytea PRIMARY KEY CHECK (octet_length(token_digest)=32),
  installation_scope text NOT NULL CHECK (installation_scope='rotamoto'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '15 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

COMMENT ON TABLE rotamoto.installation_bootstrap IS
  'Single installation bootstrap latch; no tenant or identity is created until an operator authorization is consumed.';
COMMENT ON TABLE rotamoto.bootstrap_authorizations IS
  'Digest-only, short-lived, installation-scoped, one-use local operator authorizations.';

REVOKE ALL ON rotamoto.installation_bootstrap, rotamoto.bootstrap_authorizations FROM PUBLIC;
GRANT SELECT, UPDATE ON rotamoto.installation_bootstrap TO rotamoto_app;
GRANT SELECT, INSERT, UPDATE ON rotamoto.bootstrap_authorizations TO rotamoto_app;
