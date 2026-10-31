ALTER TABLE rotamoto.companies
  ADD COLUMN order_origins jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN order_origins_version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT companies_order_origins_array_ck CHECK (jsonb_typeof(order_origins)='array'),
  ADD CONSTRAINT companies_order_origins_version_ck CHECK (order_origins_version > 0);

COMMENT ON COLUMN rotamoto.companies.order_origins IS
  'Canonical tenant-scoped local order origins. External marketplace connections remain in integrations.';
