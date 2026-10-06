DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM rotamoto.dispatch_attempts)
     OR EXISTS (SELECT 1 FROM rotamoto.delivery_fulfillments)
     OR EXISTS (SELECT 1 FROM rotamoto.logistics_providers) THEN
    RAISE EXCEPTION 'rollback bloqueado: catálogo ou histórico de fulfillment já contém registros';
  END IF;
END $$;

DROP TABLE rotamoto.dispatch_attempts;
DROP TABLE rotamoto.delivery_fulfillments;
DROP TABLE rotamoto.logistics_providers;
DROP FUNCTION rotamoto.guard_fulfillment_provider_mode();
