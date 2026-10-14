-- This migration expands accepted provider/event/command data and replaces a
-- worker claim function. A rollback may strand 99Food account/order/audit data;
-- the migration runner must not delete or rewrite those records automatically.
DO $$ BEGIN RAISE EXCEPTION 'Rollback 0042 bloqueado: preserve marketplace history and perform an audited compatibility migration.'; END $$;
