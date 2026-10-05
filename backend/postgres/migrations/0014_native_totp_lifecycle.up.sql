ALTER TABLE rotamoto.credentials
  ADD COLUMN mfa_totp_last_counter bigint,
  ADD COLUMN mfa_enrollment_secret_ref text,
  ADD COLUMN mfa_enrollment_expires_at timestamptz,
  ADD COLUMN mfa_failed_attempts integer NOT NULL DEFAULT 0 CHECK (mfa_failed_attempts >= 0),
  ADD COLUMN mfa_locked_until timestamptz,
  ADD CONSTRAINT credentials_mfa_enrollment_pair_check CHECK
    ((mfa_enrollment_secret_ref IS NULL) = (mfa_enrollment_expires_at IS NULL)),
  ADD CONSTRAINT credentials_mfa_counter_check CHECK (mfa_totp_last_counter IS NULL OR mfa_totp_last_counter >= 0);

ALTER TABLE rotamoto.recovery_tokens
  ADD COLUMN purpose text NOT NULL DEFAULT 'password_recovery',
  ADD CONSTRAINT recovery_tokens_purpose_check CHECK (purpose IN ('password_recovery','mfa_recovery'));

CREATE INDEX recovery_tokens_mfa_live_idx ON rotamoto.recovery_tokens(user_id, expires_at)
  WHERE purpose='mfa_recovery' AND consumed_at IS NULL;

COMMENT ON COLUMN rotamoto.credentials.mfa_secret_ref IS
  'Opaque reference to encrypted server-side TOTP secret; never store plaintext MFA secrets in PostgreSQL.';
