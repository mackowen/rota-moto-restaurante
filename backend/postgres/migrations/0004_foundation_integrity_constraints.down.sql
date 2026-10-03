SET LOCAL row_security = off;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM rotamoto.audit_log WHERE actor_kind='user' AND actor_user_id IS NULL) THEN
    RAISE EXCEPTION 'rollback bloqueado: auditoria possui actor de usuário sem ID';
  END IF;
  IF EXISTS (SELECT 1 FROM rotamoto.sessions
      WHERE last_seen_at>idle_expires_at OR idle_expires_at>absolute_expires_at) THEN
    RAISE EXCEPTION 'rollback bloqueado: sessão possui expiração inconsistente';
  END IF;
  IF EXISTS (SELECT 1 FROM rotamoto.sync_outbox WHERE published_at<created_at) THEN
    RAISE EXCEPTION 'rollback bloqueado: outbox possui publicação anterior à criação';
  END IF;
END $$;

ALTER TABLE rotamoto.sync_outbox DROP CONSTRAINT sync_outbox_publish_time_check;
ALTER TABLE rotamoto.sessions DROP CONSTRAINT sessions_expiry_order_check;
ALTER TABLE rotamoto.audit_log DROP CONSTRAINT audit_log_user_actor_required;
