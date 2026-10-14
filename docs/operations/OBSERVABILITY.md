# API health and operational signals

The API binds to loopback by default. A trusted, authenticated reverse proxy is
required before any remote exposure; these endpoints do not provide operator
authentication.

- `GET /health/live` reports that the Node process can serve HTTP. It does not
  test PostgreSQL.
- `GET /health/ready` performs a bounded read-only schema probe using the same
  pool supplied to `startServer`. It returns `503` when PostgreSQL is
  unavailable or the required schema capabilities are missing.
- `GET /health/metrics` returns process-lifetime request counts and bounded
  duration buckets grouped only by HTTP method, broad request category and
  status class. It contains no path, tenant, account, order or user labels.

The API emits one JSON request record with a correlation ID, method, path,
status, elapsed milliseconds and a normalized error code. Do not add request
bodies, cookies, authorization headers or tenant identifiers to these logs.
The ID is returned as `X-Request-ID` and in JSON responses.

## Basic response procedure

1. Check `/health/live` and `/health/ready` independently.
2. If liveness fails, inspect the local service supervisor and sanitized
   `http.start_failed` / `http.bootstrap_failed` events. Do not restart the
   Termux service as part of an application test.
3. If readiness fails, correlate the timestamp and request ID with
   `postgres.pool.error`; verify the local PostgreSQL process, connection
   target and schema deployment through the approved operator procedure.
4. If sync errors rise, inspect aggregate `sync` metrics and request IDs. Use
   the existing E2E fixture manifest for synthetic reproductions; never log
   packet payloads or clear inbox/outbox/audit data to recover a queue.
5. Provider worker logs should be checked by their sanitized event and error
   codes. This API endpoint does not expose per-tenant queue contents or worker
   internals.

Metrics are in memory and reset when the process restarts. They are diagnostic
signals, not durable monitoring, alert delivery, SLOs, or evidence of sustained
availability. External collection, retention and alert thresholds require an
operator-approved deployment design.
