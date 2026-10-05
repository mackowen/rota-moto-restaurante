DROP INDEX IF EXISTS rotamoto.recovery_tokens_mfa_live_idx;
ALTER TABLE rotamoto.recovery_tokens
  DROP CONSTRAINT IF EXISTS recovery_tokens_purpose_check,
  DROP COLUMN IF EXISTS purpose;
ALTER TABLE rotamoto.credentials
  DROP CONSTRAINT IF EXISTS credentials_mfa_counter_check,
  DROP CONSTRAINT IF EXISTS credentials_mfa_enrollment_pair_check,
  DROP COLUMN IF EXISTS mfa_locked_until,
  DROP COLUMN IF EXISTS mfa_failed_attempts,
  DROP COLUMN IF EXISTS mfa_enrollment_expires_at,
  DROP COLUMN IF EXISTS mfa_enrollment_secret_ref,
  DROP COLUMN IF EXISTS mfa_totp_last_counter;
