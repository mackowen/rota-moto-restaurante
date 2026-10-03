CREATE TABLE rotamoto.provisioning_requests (
  idempotency_key_digest bytea PRIMARY KEY CHECK (octet_length(idempotency_key_digest) = 32),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  delivery_status text NOT NULL CHECK (delivery_status IN ('pending','sent','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rotamoto.identity_tokens (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('owner_invitation','email_verification')),
  token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  FOREIGN KEY (company_id, user_id) REFERENCES rotamoto.memberships(company_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX identity_tokens_user_purpose_expiry_idx
  ON rotamoto.identity_tokens(user_id, purpose, expires_at);

INSERT INTO rotamoto.permissions (permission_key, catalog_version, description) VALUES
  ('company.manage', 1, 'Gerenciar dados e estado da empresa'),
  ('members.invite', 1, 'Convidar membros para a empresa'),
  ('members.read', 1, 'Consultar membros da empresa'),
  ('orders.read', 1, 'Consultar pedidos da empresa'),
  ('orders.manage', 1, 'Gerenciar pedidos da empresa'),
  ('integrations.manage', 1, 'Gerenciar integrações da empresa')
ON CONFLICT (permission_key, catalog_version) DO NOTHING;

COMMENT ON TABLE rotamoto.provisioning_requests IS
  'Idempotency records for the trusted administrative provisioner; stores digests and canonical IDs only.';
COMMENT ON TABLE rotamoto.identity_tokens IS
  'Single-use invitation and email-verification digests; raw tokens are delivered once and never persisted.';
