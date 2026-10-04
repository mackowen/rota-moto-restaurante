DROP INDEX IF EXISTS rotamoto.domain_active_route_delivery_gin_idx;
ALTER TABLE rotamoto.domain_records
  DROP CONSTRAINT IF EXISTS domain_route_delivery_ids_check,
  DROP CONSTRAINT IF EXISTS domain_earning_amount_minor_check,
  DROP CONSTRAINT IF EXISTS domain_earning_currency_check,
  DROP CONSTRAINT IF EXISTS domain_earning_components_check;
DROP FUNCTION IF EXISTS rotamoto.valid_route_delivery_ids(jsonb);
