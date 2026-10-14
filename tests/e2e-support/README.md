# PostgreSQL E2E fixture manifests

`fixture-lifecycle.js` creates a durable manifest before connecting to PostgreSQL. The default directory is
`~/.local/state/rotamoto/e2e-fixtures`; set `ROTAMOTO_E2E_MANIFEST_DIR` to select another private local directory.
The directory is mode `0700`, manifest files are mode `0600`, and each update uses a synced temporary file plus atomic rename.

Every run has a UUID, campaign, fixed `rotamoto_e2e` environment, lifecycle status/history, synthetic tenant and
user/session IDs, registered entity IDs, evidence references and a retention reason. Credentials, tokens, email,
phone, address, cookies and CSRF data are rejected by the manifest field-name guard and are never recorded.
`ROTAMOTO_E2E_CAMPAIGN` sets the campaign label; the default `unassigned` is explicit.

Status transitions are `PREPARING` → `RUNNING` → `COMPLETED`, `FAILED`, `INTERRUPTED` or `RETAINED`. A process
ending without its finalizer leaves `RUNNING`; `recover <run-uuid>` marks it `INTERRUPTED` only after confirming
the recorded local process is no longer running. `resume <run-uuid>` reopens only the inventory/reconciliation
stage and never replays fixture writes. The status history keeps all transitions.

`node scripts/e2e-fixtures.js inventory` lists registered-ID counts per run/tenant and, where the lifecycle has
read privileges, read-only table counts scoped to each known tenant. These counts do not imply a global inventory.
Rows hidden by RLS are not treated as absent. A tenant created outside the lifecycle must be registered with
`fixture.registerFixtureTenant(...)` before its first committed write; never include secret values in IDs or notes.

Single-session fixture tests run in a transaction and verify zero residual rows after rollback. Independent-session
tests must set `retainIndependentFixture: true`; committed fixtures remain retained and `audit_log` is never
deleted. No cleanup command exists. Completion or interruption alone does not establish removal eligibility.
Any future cleanup requires separate authorization, proven run ownership, explicit allowlisting, FK/dependency
validation, audit retention, and a dry-run review. The manifest mechanism never grants a database privilege and
all PostgreSQL operations remain limited to the prevalidated loopback `rotamoto_e2e` target.
