REVOKE UPDATE (time_zone, updated_at) ON TABLE rotamoto.companies FROM rotamoto_app;
REVOKE SELECT (time_zone) ON TABLE rotamoto.companies FROM rotamoto_app;
ALTER TABLE rotamoto.companies DROP COLUMN time_zone;
