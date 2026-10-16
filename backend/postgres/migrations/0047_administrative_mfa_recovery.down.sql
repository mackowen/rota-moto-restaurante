DO $rollback$
BEGIN
  IF EXISTS (SELECT 1 FROM rotamoto.mfa_recovery_requests) OR
     EXISTS (SELECT 1 FROM rotamoto.mfa_recovery_challenges) THEN
    RAISE EXCEPTION 'rollback blocked: MFA recovery history exists; use a reviewed forward migration';
  END IF;
END;
$rollback$;
DROP TABLE rotamoto.mfa_recovery_challenges;
DROP TABLE rotamoto.mfa_recovery_requests;
