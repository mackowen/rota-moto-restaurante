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
DATABASE_URL='postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto' node backend/postgres/migrate.js up
DATABASE_URL='postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto' node backend/postgres/migrate.js status
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

`npm run test:postgres` currently uses one `DATABASE_URL` for migration DDL,
runtime RLS checks, and fixtures. Do not use `rotamoto_migrator` as a substitute
for testing runtime privileges or assume the suite is split-role ready; adapt
that harness to separate migration and runtime connections before post-split
database test execution.

## Role ownership gate

The live database remains in the pre-split state until the manual DBA procedure
in `admin/role-split-runbook.md` is executed and postflight checks pass. The
versioned SQL is preparation only; it has not been run. Until then,
`rotamoto_app` is still database/schema/table owner and this setup is suitable
only for isolated development and tests, not external exposure.

Down migrations are conservative and may refuse rollback when tenant data
exists or when an explicit review is required. Prefer forward migrations; do
not treat an application-owned development schema as a production migration
boundary.

No production database URL, password, or secret-manager value belongs in Git.
