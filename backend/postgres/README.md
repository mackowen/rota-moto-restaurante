# PostgreSQL identity and domain foundation (DEC-0002)

This directory contains the PostgreSQL schema and migration infrastructure for
DEC-0002. Identity services and an HTTP identity API now exist in
`backend/identity/` and `server.js`; the listener remains bound to loopback.
The API still fails closed for administrative provisioning until an operational
operator adapter is configured.

The applications remain Local-First: their IndexedDB stores continue to hold
the offline operational cache and outbox. PostgreSQL is being prepared as the
canonical authority for server identity, memberships, permissions, integrations,
ID mappings, canonical domain records, and server-side sync receipts/outbox.

## Migrations

After the DBA applies the role split, run the migration CLI against the official
development database as `rotamoto_migrator`. The URL intentionally contains no
password and is for the migration process only:

```sh
MIGRATOR_DATABASE_URL='postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto' node backend/postgres/migrate.js up
MIGRATOR_DATABASE_URL='postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto' node backend/postgres/migrate.js status
```

The runner applies each migration in a transaction, serializes migration
processes with a PostgreSQL advisory lock, and stores a SHA-256 checksum. It
refuses to run if an applied migration file was edited. Database connection
details are never printed.

The first migration enables row-level security with a default-deny tenant
context on every tenant-owned table. Identity and session tables are global and
must only be queried by trusted server code.

Migrations `0005`–`0010` add the canonical domain/sync foundation without
changing `0001`–`0004`. `0008` binds each installation to its registering user.
`domain_records` stores the existing v1 entity payload
as JSONB while the database enforces canonical UUID, tenant, revision,
relationship and Delivery status constraints. `companies` remains the canonical
Company identity table. Installations namespace local aliases by tenant, app
and device; packet receipts and outbox records have installation FKs. Tenant
RLS is enabled and forced on the new tables. Runtime receives only the DML
needed by authenticated sync; it cannot delete canonical rows or mutate ID
aliases.

`POST /api/sync/installations/restaurante` and
`POST /api/sync/installations/motoboy` register a device under the authenticated
tenant and user. Registration route, permission, and session determine the
stored `app_key`; subsequent push/pull resolve the installation server-side by
that binding. `source.app` is ignored for authorization and remains descriptive
metadata. This is an authenticated installation binding, not binary app
attestation. Registration and push require CSRF and `sync.push`; pull requires
`sync.pull` and a registered installation.

Push preserves the v1 envelope and returns an `operationResults` entry for each
domain operation. A packet-level HTTP 200 means processing completed; each
entry separately reports `accepted`, `duplicate`, `rejected`, or `conflict`,
local and canonical IDs/revision where known, and a stable error code. Savepoints
allow independent operations in one packet to commit or reject independently.
Packet IDs are digest-idempotent; event IDs are immutable and idempotent across
installations. Revisions use `baseVersion`/`sync.canonicalVersion`; stale edits
conflict instead of last-write-wins. Pull uses a microsecond keyset cursor.

Ownership follows `CONTRACT.md`: Restaurant writes Order, Driver, Route, and
Earning; Moto writes LocationPoint, DeliveryProof, and DeliveryEvent execution
facts. The server projects allowed execution events onto Delivery state. Only
Restaurant creates/plans/assigns/cancels Delivery; Moto cannot publish Delivery
or canonical Earning. `races` and `settings` are local projections and are not
persisted as canonical entities. Tombstones follow the owning application and
share the operation ACK semantics.

Migration `0009` bounds Route.deliveryIds to distinct canonical UUIDs and adds
safe Earning amount/currency/components checks plus a Route membership GIN
index. Route.deliveryIds is the only stored relation; the push transaction
resolves aliases, checks tenant/existence/active uniqueness under an advisory
lock, and records changes in audit_log. Migration `0010` grants rotamoto_app
only EXECUTE on the immutable validation function called by the CHECK.

Canonical Earning uses integer amountMinor and explicit ISO currency, without
a fixed calculation formula. Legacy decimal input is normalized to minor units
with BRL compatibility at the sync boundary. DeliveryProof separates metadata
from a SHA-256 and storageRef; the sync service fails closed when no configured
blob validation provider is available. Legacy Data URLs stay in IndexedDB and
protected backups, not in canonical PostgreSQL payloads.

Both clients expose `RotaMotoSync.loginToServer` and `syncWithServer`. They keep
session CSRF only in memory, retain packet retries in the existing local outbox,
persist operation ACK/revision mappings in `syncState`, and transactionally stage
pull snapshots/inbox plus cursor in IndexedDB. Network/API failure does not
change local business records. Canonical pull snapshots are cached separately
from local projections so unresolved local edits are preserved; applying those
snapshots into each app's distinct UI model remains a later reconciliation step.

Do not set the migrator URL in the HTTP server environment. `server.js` creates
the API pool with `rotamoto_app`; the migration CLI is a separate process.
Migrations own and update `rotamoto.schema_migrations`. Runtime has no access to
the ledger. See [`admin/role-split-runbook.md`](admin/role-split-runbook.md) for
the prepared administrative script, backup gate, manual credential setup,
postflight queries, and rollback limits.

`DATABASE_URL` is reserved for the application/runtime role `rotamoto_app` and
the `rotamoto` database. Development/test may use the documented password-free
loopback default. Production requires explicit configuration, TLS
`sslmode=verify-full`, a CA file and an external secret-provider module; it
rejects loopback database hosts, secrets in the URL and
`MIGRATOR_DATABASE_URL`. The listener remains loopback-only, checks Host, role
and required schema objects before listening, and never runs migrations at
startup.
`MIGRATOR_DATABASE_URL` is required only by the migration CLI and PostgreSQL
migration test harness and must authenticate as `rotamoto_migrator`. Neither URL
contains a password; libpq/`pg` obtains credentials through the configured
credential store. The migration runner verifies the URL role and connected
`current_user` before acquiring its advisory lock. The HTTP server reads only
`DATABASE_URL` and explicitly uses the runtime role.

Runtime modes, trusted proxy IP handling, security headers, pool/time limits
and signal-driven graceful shutdown are described in
[`../../docs/operations/DEPLOY-ROLLBACK.md`](../../docs/operations/DEPLOY-ROLLBACK.md).
The development Termux/PostgreSQL/nginx environment is not production. The
HTTP process never trusts forwarded headers unless the direct proxy peer is
allowlisted; production requires an exact `TRUSTED_PROXY_ADDRESSES` list.

`npm run test:postgres` uses both URLs: schema install, migration ledger and
fixture cleanup use the migrator connection; default-deny, cross-tenant and
runtime privilege assertions use the app connection. Synthetic fixtures are
removed or rolled back before completion.

## Role ownership gate

The manual DBA procedure in `admin/role-split-runbook.md` has been executed on
the official development database. Catalog validation confirms the database is
owned by the emergency DBA, schema/domain objects by `rotamoto_migrator`, and
`rotamoto_app` has runtime-only grants. The service remains loopback-only; this
role split alone does not authorize external exposure.

Down migrations are conservative and may refuse rollback when tenant data
exists or when an explicit review is required. Prefer forward migrations; do
not treat an application-owned development schema as a production migration
boundary.

No production database URL, password, or secret-manager value belongs in Git.
