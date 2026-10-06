DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_worker') THEN
    GRANT UPDATE (status) ON rotamoto.provider_tracking_snapshots TO rotamoto_provider_worker;
  END IF;
END $$;
COMMENT ON TABLE rotamoto.provider_tracking_snapshots IS
  'Tenant-scoped external provider snapshots; no raw courier coordinates or Motoboy LocationPoint projection.';
