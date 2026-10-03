# PostgreSQL identity foundation (DEC-0002, phase 1)

This directory contains the PostgreSQL schema and migration infrastructure for
DEC-0002. Identity services and an HTTP identity API now exist in
`backend/identity/` and `server.js`; the listener remains bound to loopback.
The API still fails closed for administrative provisioning until an operational
operator adapter is configured.

The applications remain Local-First: their IndexedDB stores continue to hold
the offline operational cache and outbox. PostgreSQL is being prepared as the
canonical authority for server identity, memberships, permissions, integrations,
ID mappings, and server-side sync receipts.

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

Do not set the migrator URL in the HTTP server environment. `server.js` creates
the API pool with `rotamoto_app`; the migration CLI is a separate process.
Migrations own and update `rotamoto.schema_migrations`. Runtime has no access to
the ledger. See [`admin/role-split-runbook.md`](admin/role-split-runbook.md) for
the prepared administrative script, backup gate, manual credential setup,
postflight queries, and rollback limits.

`DATABASE_URL` is reserved for the application/runtime role `rotamoto_app` and
the official loopback database. The server refuses a migrator or remote host
URL and checks `current_user` before listening. If unset, it uses the equivalent
password-free official runtime URL for backward-compatible local startup.
`MIGRATOR_DATABASE_URL` is required only by the migration CLI and PostgreSQL
migration test harness and must authenticate as `rotamoto_migrator`. Neither URL
contains a password; libpq/`pg` obtains credentials through the configured
credential store. The migration runner verifies the URL role and connected
`current_user` before acquiring its advisory lock. The HTTP server reads only
`DATABASE_URL` and explicitly uses the runtime role.

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
