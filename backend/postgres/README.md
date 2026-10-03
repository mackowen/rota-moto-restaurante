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

Use the configured development database and its existing `.pgpass` entry. The
URL intentionally contains no password:

```sh
DATABASE_URL='postgresql://rotamoto_app@127.0.0.1:5432/rotamoto' node backend/postgres/migrate.js up
DATABASE_URL='postgresql://rotamoto_app@127.0.0.1:5432/rotamoto' node backend/postgres/migrate.js status
DATABASE_URL='postgresql://rotamoto_app@127.0.0.1:5432/rotamoto' npm run test:postgres
```

The runner applies each migration in a transaction, serializes migration
processes with a PostgreSQL advisory lock, and stores a SHA-256 checksum. It
refuses to run if an applied migration file was edited. Database connection
details are never printed.

The first migration enables row-level security with a default-deny tenant
context on every tenant-owned table. Identity and session tables are global and
must only be queried by trusted server code.

## Role ownership gate

The official development database currently has `rotamoto_app` as database,
schema, and owner of all 18 tables. It is not superuser and has no
`BYPASSRLS`/`CREATEDB`/`CREATEROLE` role attributes, but as database and table
owner it can create objects and alter or disable policies. `FORCE ROW LEVEL
SECURITY` does not prevent an owner from changing the policy itself. Therefore
this setup is suitable only for isolated development and tests; it is not a
complete production privilege boundary and must not be exposed as one.

Changing ownership requires an existing migration owner role and explicit DBA
ownership/grant operations. The current task deliberately does not change role
privileges, create substitute roles, or use a different PostgreSQL login. A
separate migration/app role boundary is a prerequisite before treating the
database/API foundation as production-ready.

Down migrations are conservative and may refuse rollback when tenant data
exists or when an explicit review is required. Prefer forward migrations; do
not treat an application-owned development schema as a production migration
boundary.

No production database URL, password, or secret-manager value belongs in Git.
