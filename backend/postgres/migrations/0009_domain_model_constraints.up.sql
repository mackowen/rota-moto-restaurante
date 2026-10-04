CREATE FUNCTION rotamoto.valid_route_delivery_ids(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN value IS NULL THEN true
    WHEN jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) > 500 THEN false
    ELSE
      (SELECT count(*) = count(DISTINCT x.value #>> '{}')
        AND coalesce(bool_and(jsonb_typeof(x.value)='string'
          AND x.value #>> '{}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),true)
       FROM jsonb_array_elements(value) AS x(value))
  END
$$;

ALTER TABLE rotamoto.domain_records
  ADD CONSTRAINT domain_route_delivery_ids_check
    CHECK (entity_type <> 'Route' OR rotamoto.valid_route_delivery_ids(payload->'deliveryIds')),
  ADD CONSTRAINT domain_earning_amount_minor_check
    CHECK (entity_type <> 'Earning' OR NOT (payload ? 'amountMinor') OR
      (jsonb_typeof(payload->'amountMinor')='number'
        AND (payload->>'amountMinor')::numeric = trunc((payload->>'amountMinor')::numeric)
        AND abs((payload->>'amountMinor')::numeric) <= 9000000000000000)),
  ADD CONSTRAINT domain_earning_currency_check
    CHECK (entity_type <> 'Earning' OR NOT (payload ? 'currency') OR payload->>'currency' ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT domain_earning_components_check
    CHECK (entity_type <> 'Earning' OR NOT (payload ? 'components') OR
      (jsonb_typeof(payload->'components')='array' AND jsonb_array_length(payload->'components')<=100));

CREATE INDEX domain_active_route_delivery_gin_idx
  ON rotamoto.domain_records USING gin ((payload->'deliveryIds'))
  WHERE entity_type='Route' AND deleted_at IS NULL;
