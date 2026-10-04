DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM rotamoto.memberships WHERE driver_id IS NOT NULL) OR
     EXISTS (SELECT 1 FROM rotamoto.sync_outbox WHERE recipient_driver_id IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback bloqueado: existem vínculos ou notificações de revogação que precisam ser preservados';
  END IF;
END;
$$;

DROP INDEX rotamoto.memberships_driver_lookup;
DROP INDEX rotamoto.memberships_driver_unique;
DROP INDEX rotamoto.sync_outbox_driver_cursor_idx;
ALTER TABLE rotamoto.memberships DROP CONSTRAINT memberships_driver_record_fk;
ALTER TABLE rotamoto.sync_outbox DROP CONSTRAINT sync_outbox_recipient_driver_fk;
ALTER TABLE rotamoto.memberships DROP COLUMN driver_id, DROP COLUMN driver_entity_type;
ALTER TABLE rotamoto.sync_outbox DROP COLUMN recipient_driver_id;
