CREATE SCHEMA IF NOT EXISTS rotamoto;

CREATE FUNCTION rotamoto.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE rotamoto.users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  email_verified_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email = btrim(email)),
  CHECK (length(email) BETWEEN 3 AND 320)
);
CREATE UNIQUE INDEX users_email_normalized_uq ON rotamoto.users (lower(email));

CREATE TABLE rotamoto.credentials (
  user_id uuid PRIMARY KEY REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  password_phc text NOT NULL CHECK (password_phc LIKE '$argon2id$%'),
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  mfa_required boolean NOT NULL DEFAULT false,
  mfa_secret_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rotamoto.recovery_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE INDEX recovery_tokens_user_expiry_idx ON rotamoto.recovery_tokens(user_id, expires_at);

CREATE TABLE rotamoto.companies (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning','active','suspended','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rotamoto.permissions (
  permission_key text NOT NULL CHECK (permission_key ~ '^[a-z][a-z0-9_.:-]{1,119}$'),
  catalog_version integer NOT NULL CHECK (catalog_version > 0),
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (permission_key, catalog_version)
);

CREATE TABLE rotamoto.roles (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  role_key text NOT NULL CHECK (role_key ~ '^[a-z][a-z0-9_-]{1,63}$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
  is_system_template boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, role_key),
  UNIQUE (id, company_id)
);

CREATE TABLE rotamoto.role_permissions (
  company_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission_key text NOT NULL,
  catalog_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_key, catalog_version),
  FOREIGN KEY (permission_key, catalog_version) REFERENCES rotamoto.permissions(permission_key, catalog_version) ON DELETE RESTRICT,
  FOREIGN KEY (role_id, company_id) REFERENCES rotamoto.roles(id, company_id) ON DELETE RESTRICT
);

CREATE TABLE rotamoto.memberships (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  role_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','suspended','revoked')),
  invited_by_user_id uuid REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id),
  UNIQUE (company_id, id),
  FOREIGN KEY (role_id, company_id) REFERENCES rotamoto.roles(id, company_id) ON DELETE RESTRICT
);
CREATE INDEX memberships_user_status_idx ON rotamoto.memberships(user_id, status);

CREATE TABLE rotamoto.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  active_company_id uuid NOT NULL,
  token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
  csrf_digest bytea NOT NULL CHECK (octet_length(csrf_digest) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  rotated_from_session_id uuid REFERENCES rotamoto.sessions(id) ON DELETE RESTRICT,
  FOREIGN KEY (active_company_id, user_id) REFERENCES rotamoto.memberships(company_id, user_id) ON DELETE RESTRICT,
  CHECK (idle_expires_at > created_at),
  CHECK (absolute_expires_at > created_at),
  CHECK (last_seen_at >= created_at)
);
CREATE INDEX sessions_user_live_idx ON rotamoto.sessions(user_id, absolute_expires_at) WHERE revoked_at IS NULL;
CREATE INDEX sessions_company_user_idx ON rotamoto.sessions(active_company_id, user_id);

CREATE TABLE rotamoto.integrations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('ifood','99food','keeta')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled','error')),
  created_by_user_id uuid REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, provider),
  UNIQUE (id, company_id)
);

CREATE TABLE rotamoto.external_accounts (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  external_account_id text NOT NULL CHECK (length(btrim(external_account_id)) BETWEEN 1 AND 255),
  display_name text,
  link_status text NOT NULL DEFAULT 'unconfirmed' CHECK (link_status IN ('unconfirmed','confirmed','revoked')),
  confirmed_at timestamptz,
  secret_ref text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, external_account_id),
  UNIQUE (id, company_id),
  FOREIGN KEY (integration_id, company_id) REFERENCES rotamoto.integrations(id, company_id) ON DELETE RESTRICT,
  CHECK ((link_status = 'confirmed') = (confirmed_at IS NOT NULL))
);

CREATE TABLE rotamoto.local_id_maps (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  app_key text NOT NULL CHECK (app_key IN ('restaurante','motoboy')),
  installation_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  local_id text NOT NULL CHECK (length(btrim(local_id)) BETWEEN 1 AND 255),
  canonical_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, app_key, installation_id, entity_type, local_id),
  CHECK (last_seen_at >= first_seen_at)
);
CREATE INDEX local_id_maps_canonical_idx ON rotamoto.local_id_maps(company_id, entity_type, canonical_id);

CREATE TABLE rotamoto.audit_log (
  id uuid PRIMARY KEY,
  company_id uuid REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user','admin_provisioner','worker','webhook','system')),
  action text NOT NULL CHECK (length(btrim(action)) BETWEEN 1 AND 120),
  resource_type text,
  resource_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX audit_log_company_time_idx ON rotamoto.audit_log(company_id, occurred_at DESC);
CREATE INDEX audit_log_actor_time_idx ON rotamoto.audit_log(actor_user_id, occurred_at DESC);

CREATE TABLE rotamoto.sync_inbox (
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  packet_id uuid NOT NULL,
  app_key text NOT NULL CHECK (app_key IN ('restaurante','motoboy')),
  installation_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload_digest bytea NOT NULL CHECK (octet_length(payload_digest) = 32),
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
  PRIMARY KEY (company_id, packet_id)
);

CREATE TABLE rotamoto.sync_outbox (
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL,
  app_key text NOT NULL CHECK (app_key IN ('restaurante','motoboy')),
  installation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (company_id, event_id)
);
CREATE INDEX sync_outbox_pending_idx ON rotamoto.sync_outbox(company_id, created_at) WHERE published_at IS NULL;

CREATE FUNCTION rotamoto.guard_audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$ BEGIN RAISE EXCEPTION 'audit_log é append-only'; END $$;
CREATE TRIGGER audit_log_no_update_or_delete
  BEFORE UPDATE OR DELETE ON rotamoto.audit_log
  FOR EACH ROW EXECUTE FUNCTION rotamoto.guard_audit_log_immutable();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'companies','roles','role_permissions','memberships','integrations',
    'external_accounts','local_id_maps','audit_log','sync_inbox','sync_outbox'
  ] LOOP
    EXECUTE format('ALTER TABLE rotamoto.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE rotamoto.%I FORCE ROW LEVEL SECURITY', table_name);
    IF table_name = 'companies' THEN
      EXECUTE 'CREATE POLICY tenant_isolation ON rotamoto.companies USING (id = rotamoto.current_tenant_id()) WITH CHECK (id = rotamoto.current_tenant_id())';
    ELSE
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON rotamoto.%I USING (company_id = rotamoto.current_tenant_id()) WITH CHECK (company_id = rotamoto.current_tenant_id())',
        table_name
      );
    END IF;
  END LOOP;
END $$;

COMMENT ON SCHEMA rotamoto IS 'RotaMoto server identity, tenant and sync metadata; browser apps remain Local-First.';
COMMENT ON TABLE rotamoto.credentials IS 'Stores Argon2id PHC hashes only; raw passwords are never persisted.';
COMMENT ON TABLE rotamoto.sessions IS 'Opaque session and CSRF token digests only; cookies are issued by a future authenticated API.';
COMMENT ON TABLE rotamoto.external_accounts IS 'secret_ref is a pointer for a future KMS/secret manager, never a provider credential.';
