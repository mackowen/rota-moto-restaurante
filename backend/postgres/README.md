# PostgreSQL identity foundation (DEC-0002, phase 1)

This directory contains the first server persistence layer for DEC-0002. It is
schema and migration infrastructure only. It does not add login routes, tenant
provisioning, API exposure, or credentials. The existing integration service
remains bound to loopback.

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
context on every tenant-owned table. The application role must not own these
tables or have `BYPASSRLS`; deployment role grants and tenant context setup
belong to later API authorization work. Identity and session tables are global
and must only be queried by trusted server code.

The down migration deliberately refuses to run under `rotamoto_app`. Forced RLS
means this limited application role cannot safely prove that every tenant table
is empty. Production changes should use forward migrations; a separately
authorized migration role is required before a rollback can be considered.
The current runner therefore refuses `down` under `rotamoto_app`.

No production database URL, password, or secret-manager value belongs in Git.
