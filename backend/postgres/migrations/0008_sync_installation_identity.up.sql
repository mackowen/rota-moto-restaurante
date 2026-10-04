ALTER TABLE rotamoto.sync_installations
  ADD COLUMN registered_by_user_id uuid REFERENCES rotamoto.users(id) ON DELETE RESTRICT;

CREATE INDEX sync_installations_registered_user_idx
  ON rotamoto.sync_installations(company_id, registered_by_user_id, app_key, local_device_id);
