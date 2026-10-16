-- MFA factor recovery is a two-stage workflow: a global digest-only email
-- challenge, followed by a tenant-scoped request requiring an independent
-- MFA-verified administrator (or an audited local operator for a sole owner).
CREATE TABLE rotamoto.mfa_recovery_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest)=32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '30 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE INDEX mfa_recovery_challenges_live_idx
  ON rotamoto.mfa_recovery_challenges(user_id,expires_at) WHERE consumed_at IS NULL;

CREATE TABLE rotamoto.mfa_recovery_requests (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  email_verified_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by_user_id uuid REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  decision_actor_ref text,
  completed_at timestamptz,
  CHECK (expires_at > requested_at),
  CHECK ((decided_at IS NULL) = (status='pending')),
  CHECK (decided_by_user_id IS NULL OR decision_actor_ref IS NULL),
  CHECK (decided_at IS NULL OR ((decided_by_user_id IS NULL) <> (decision_actor_ref IS NULL))),
  CHECK (completed_at IS NULL OR (decided_at IS NOT NULL AND status='approved')),
  UNIQUE (id,company_id)
);
CREATE UNIQUE INDEX mfa_recovery_one_pending_per_user_company
  ON rotamoto.mfa_recovery_requests(company_id,user_id) WHERE status='pending';
CREATE INDEX mfa_recovery_requests_company_idx
  ON rotamoto.mfa_recovery_requests(company_id,requested_at DESC);

ALTER TABLE rotamoto.mfa_recovery_challenges
  ADD COLUMN request_id uuid REFERENCES rotamoto.mfa_recovery_requests(id) ON DELETE RESTRICT;
CREATE INDEX mfa_recovery_challenges_request_idx
  ON rotamoto.mfa_recovery_challenges(request_id) WHERE request_id IS NOT NULL;

REVOKE ALL ON rotamoto.mfa_recovery_challenges,rotamoto.mfa_recovery_requests FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON rotamoto.mfa_recovery_challenges TO rotamoto_app;
GRANT SELECT,INSERT,UPDATE ON rotamoto.mfa_recovery_requests TO rotamoto_app;

ALTER TABLE rotamoto.mfa_recovery_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.mfa_recovery_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.mfa_recovery_requests
  USING (company_id=rotamoto.current_tenant_id())
  WITH CHECK (company_id=rotamoto.current_tenant_id());

COMMENT ON TABLE rotamoto.mfa_recovery_challenges IS
  'Private digest-only short-lived email challenges; exposed only to trusted identity backend code.';
COMMENT ON TABLE rotamoto.mfa_recovery_requests IS
  'Tenant-scoped, audited administrative MFA recovery requests; never a public MFA bypass.';
