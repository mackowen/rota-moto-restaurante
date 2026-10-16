DO $rollback$
BEGIN
  RAISE EXCEPTION 'rollback blocked: clearing the bootstrap latch could permit duplicate first-owner provisioning';
END;
$rollback$;
