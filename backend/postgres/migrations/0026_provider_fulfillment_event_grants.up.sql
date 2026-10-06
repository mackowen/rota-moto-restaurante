DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_worker') THEN
    GRANT SELECT (company_id,fulfillment_id,delivery_id,provider_id,mode,status,revision,selected_by,updated_by)
      ON rotamoto.delivery_fulfillments TO rotamoto_provider_worker;
    GRANT UPDATE (status,revision,updated_by,updated_at)
      ON rotamoto.delivery_fulfillments TO rotamoto_provider_worker;
  END IF;
END $$;
COMMENT ON TABLE rotamoto.delivery_fulfillments IS
  'Shared fulfillment projection; the isolated provider worker may apply only validated external status transitions.';
