REVOKE UPDATE (name, support_phone, operational_address, operational_latitude, operational_longitude,
  operational_location_provenance, operational_location_version, company_settings_version, updated_at) ON TABLE rotamoto.companies FROM rotamoto_app;
REVOKE SELECT (support_phone, operational_address, operational_latitude, operational_longitude,
  operational_location_provenance, operational_location_version, company_settings_version) ON TABLE rotamoto.companies FROM rotamoto_app;
ALTER TABLE rotamoto.companies
  DROP CONSTRAINT companies_support_phone_length,
  DROP CONSTRAINT companies_operational_location_requires_provenance,
  DROP CONSTRAINT companies_operational_location_version,
  DROP CONSTRAINT companies_settings_version,
  DROP CONSTRAINT companies_operational_location_provenance,
  DROP CONSTRAINT companies_operational_longitude_range,
  DROP CONSTRAINT companies_operational_latitude_range,
  DROP CONSTRAINT companies_operational_coordinates_pair,
  DROP CONSTRAINT companies_operational_address_length,
  DROP COLUMN operational_location_version,
  DROP COLUMN company_settings_version,
  DROP COLUMN support_phone,
  DROP COLUMN operational_location_provenance,
  DROP COLUMN operational_longitude,
  DROP COLUMN operational_latitude,
  DROP COLUMN operational_address;
