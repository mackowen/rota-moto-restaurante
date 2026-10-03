ALTER TABLE rotamoto.audit_log
  ADD CONSTRAINT audit_log_user_actor_required
  CHECK (actor_kind <> 'user' OR actor_user_id IS NOT NULL);

ALTER TABLE rotamoto.sessions
  ADD CONSTRAINT sessions_expiry_order_check
  CHECK (last_seen_at <= idle_expires_at AND idle_expires_at <= absolute_expires_at);

ALTER TABLE rotamoto.sync_outbox
  ADD CONSTRAINT sync_outbox_publish_time_check
  CHECK (published_at IS NULL OR published_at >= created_at);
