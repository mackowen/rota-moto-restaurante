ALTER TABLE rotamoto.identity_tokens
  DROP CONSTRAINT identity_tokens_purpose_check;
ALTER TABLE rotamoto.identity_tokens
  ADD CONSTRAINT identity_tokens_purpose_check
  CHECK (purpose IN ('owner_invitation','membership_invitation','email_verification'));
ALTER TABLE rotamoto.sessions ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;

GRANT UPDATE (display_name, updated_at) ON TABLE rotamoto.roles TO rotamoto_app;
GRANT DELETE ON TABLE rotamoto.role_permissions TO rotamoto_app;

COMMENT ON COLUMN rotamoto.memberships.status IS
  'Lifecycle: invited -> active after verified invitation; active -> suspended/revoked; suspended -> active after account verification. Never client-authoritative.';
COMMENT ON TABLE rotamoto.identity_tokens IS
  'Single-use digests for owner and membership invitation, email verification; raw tokens are delivered once and never persisted.';
