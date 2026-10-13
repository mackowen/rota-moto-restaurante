DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM rotamoto.restaurant_driver_presence WHERE revision>1 OR confirmed OR is_present) OR
     EXISTS (SELECT 1 FROM rotamoto.restaurant_presence_qr_nonces) OR
     EXISTS (SELECT 1 FROM rotamoto.restaurant_dispatch_settings WHERE mode<>'manual' OR revision>0) THEN
    RAISE EXCEPTION 'Restaurant driver queue has operational history; preserve it and use a forward migration.';
  END IF;
END $$;
DROP TABLE rotamoto.restaurant_presence_qr_nonces;
DROP TABLE rotamoto.restaurant_driver_presence;
DROP TABLE rotamoto.restaurant_dispatch_settings;
