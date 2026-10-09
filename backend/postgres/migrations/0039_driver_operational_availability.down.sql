DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM rotamoto.driver_availability WHERE status='online') OR
     EXISTS (SELECT 1 FROM rotamoto.driver_availability_commands) THEN
    RAISE EXCEPTION 'Availability has operational history; preserve it and use a forward migration.';
  END IF;
END;
$$;
DROP TABLE rotamoto.driver_availability_commands;
DROP TABLE rotamoto.driver_availability;
