ALTER TABLE rotamoto.companies
  ADD COLUMN support_phone text,
  ADD COLUMN operational_address text,
  ADD COLUMN operational_latitude double precision,
  ADD COLUMN operational_longitude double precision,
  ADD COLUMN operational_location_provenance text,
  ADD COLUMN operational_location_version integer NOT NULL DEFAULT 0,
  ADD COLUMN company_settings_version integer NOT NULL DEFAULT 0;

ALTER TABLE rotamoto.companies
  ADD CONSTRAINT companies_support_phone_length CHECK (support_phone IS NULL OR length(btrim(support_phone)) BETWEEN 1 AND 40),
  ADD CONSTRAINT companies_operational_address_length CHECK (
    operational_address IS NULL OR length(btrim(operational_address)) BETWEEN 1 AND 500
  ),
  ADD CONSTRAINT companies_operational_coordinates_pair CHECK (
    (operational_latitude IS NULL) = (operational_longitude IS NULL)
  ),
  ADD CONSTRAINT companies_operational_latitude_range CHECK (
    operational_latitude IS NULL OR operational_latitude BETWEEN -90 AND 90
  ),
  ADD CONSTRAINT companies_operational_longitude_range CHECK (
    operational_longitude IS NULL OR operational_longitude BETWEEN -180 AND 180
  ),
  ADD CONSTRAINT companies_operational_location_provenance CHECK (
    operational_location_provenance IS NULL OR operational_location_provenance = 'operator_confirmed'
  ),
  ADD CONSTRAINT companies_operational_location_version CHECK (operational_location_version >= 0),
  ADD CONSTRAINT companies_settings_version CHECK (company_settings_version >= 0),
  ADD CONSTRAINT companies_operational_location_requires_provenance CHECK (
    operational_latitude IS NULL OR operational_location_provenance = 'operator_confirmed'
  );

GRANT SELECT (support_phone, operational_address, operational_latitude, operational_longitude,
  operational_location_provenance, operational_location_version, company_settings_version) ON TABLE rotamoto.companies TO rotamoto_app;
GRANT UPDATE (name, support_phone, operational_address, operational_latitude, operational_longitude,
  operational_location_provenance, operational_location_version, company_settings_version, updated_at) ON TABLE rotamoto.companies TO rotamoto_app;

COMMENT ON COLUMN rotamoto.companies.operational_location_provenance IS
  'Only coordinates explicitly confirmed by an authorized Restaurant operator are accepted as operational origin.';
