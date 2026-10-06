ALTER TABLE rotamoto.companies
  ADD COLUMN time_zone text CHECK (time_zone IS NULL OR (length(time_zone) BETWEEN 1 AND 128));

GRANT SELECT (time_zone) ON TABLE rotamoto.companies TO rotamoto_app;
GRANT UPDATE (time_zone, updated_at) ON TABLE rotamoto.companies TO rotamoto_app;

COMMENT ON COLUMN rotamoto.companies.time_zone IS
  'Optional canonical IANA operational timezone. NULL means the operator has not configured it.';
