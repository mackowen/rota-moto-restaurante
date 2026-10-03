# Backend identity services

These modules are internal services. They are not mounted as HTTP routes and do not enable public signup. The existing integration server remains loopback-only.

## Provisioning boundary

`createIdentityService()` requires two explicit adapters before it can provision an owner:

- `authorizeProvisioner({ action, email })` must authenticate an operator through a deployment-controlled administrative process and return a trusted `actorRef` for the audit record.
- `emailProvider.send(message)` must deliver invitation/recovery messages through a configured provider. The adapter receives the raw one-time token only in memory; the database stores a SHA-256 digest.

There is no default authorization or email implementation. Missing adapters fail before the service writes. Do not implement an adapter that trusts a request body, a client-supplied actor name, or an unauthenticated local HTTP call. Email messages need a deployment-configured HTTPS origin when they are rendered as links.

Provisioning generates company, user, membership and role UUIDv7 identifiers on the server, grants only the versioned owner permission catalog, and performs the creation in one transaction. The idempotency key and normalized request are digest-only. A delivery lease prevents concurrent retries from invalidating an invitation while it is being sent; after a failed or stale attempt, retrying with the same key replaces the previous invitation token. Provider adapters must use bounded network timeouts. Provisioning audit events omit email, password and token data.

Accepting an owner invitation verifies control of the invited email, consumes the token once, creates the Argon2id credential, activates the membership/company and requires MFA. The owner cannot authenticate until an MFA flow is available. Password recovery uses the existing `recovery_tokens` digest table, has a one-hour expiry, invalidates previous recovery tokens, consumes once, and revokes existing sessions. Unknown and known email recovery requests have the same response shape.

## Passwords, sessions and tenant context

Argon2id uses a 16-byte random salt, 64 MiB memory, three passes and two lanes. Passwords are not logged or stored in plain text. PHC verification accepts bounded resource parameters only. The implementation uses `crypto.argon2`, available from Node.js 24.7; the existing integration server can still run on its documented Node 18 floor, but identity services fail closed on older runtimes.

Session tokens and CSRF tokens are random 256-bit values; only SHA-256 digests are persisted. Sessions carry a 30-minute sliding idle expiry and a 12-hour absolute expiry. `authenticate()` requires a company selection and checks that the authenticated user has an active membership in it; that ID is only a selection hint, never authority. `withAuthenticatedTenant()` resolves the company from the stored session, sets transaction-local RLS context and checks the role permission before invoking application work. Company switching requires a matching active membership. Session cookies are returned with `Secure`, `HttpOnly`, `SameSite=Lax` and the `__Host-` prefix; an HTTPS API must set the cookie and enforce CSRF on state-changing browser requests.

`identity_tokens` and `provisioning_requests` are global lookup metadata so a one-time token/idempotency digest can locate its tenant before the transaction installs tenant RLS context. No raw token, email delivery payload or secret is stored there. Tenant writes, memberships, roles, role permissions, audit events and the remaining tenant tables continue to use forced RLS. The internal services must not expose these lookup tables through an API.

## Remaining deployment work

No email domain/provider, administrative ownership proof mechanism, HTTPS origin, MFA secret manager, HTTP authentication routes, API rate limiter, or production CSRF middleware is configured here. Those pieces must be supplied and verified before mounting these services or enabling remote access. The owner MFA flag intentionally remains required until a real MFA enrollment/verification flow can protect its secret with an approved KMS/secret manager.


## HTTP identity API

`http.js` mounts a loopback-only HTTP adapter around the existing identity service. It exposes `POST /api/identity/login`, `POST /api/identity/logout`, `GET /api/identity/session`, `POST /api/identity/tenant`, `POST /api/identity/recovery`, `POST /api/identity/recovery/consume`, `POST /api/identity/invitations/accept`, and the protected `POST /api/admin/tenants/provision`. There is no public signup.

State-changing authenticated requests require same-origin `Origin` when present and the session CSRF token in `X-CSRF-Token`. The browser session remains an opaque `__Host-rotamoto_session` Secure, HttpOnly, SameSite=Lax cookie; JSON responses never return the raw session token, password hash, or recovery/invitation token. Tenant context and permission decisions come from the validated session and PostgreSQL membership/role tables; client `companyId` is only a requested membership selection. The HTTP adapter caps JSON bodies at 16 KiB, rejects unknown fields, rate-limits by socket IP and endpoint, ignores forwarded IP headers, returns normalized errors, and logs only request ID/method/path/status/duration.

Provisioning is closed unless the existing `authorizeProvisioner` adapter is configured. The adapter receives `{ action, email, context: { request } }` and must authenticate a real privileged operator, enforce the administrative permission and MFA policy, validate CSRF for browser callers, and return an auditable `actorRef`. A fake adapter is used only by rollback-based tests; there is no HTTP header bypass or public provisioning fallback.

Recovery delivery is closed unless the existing email provider is configured. The HTTP API returns a generic accepted result and never returns a raw token. Invite acceptance also marks the verified address in the existing transaction. Production HTTPS/domain, email delivery, real operator/MFA adapter, and a shared rate-limit store for multiple server instances remain deployment work.

Password hashing uses the maintained `argon2` Node binding (Argon2id v19 with the existing 64 MiB / 3-pass / 2-lane parameters). The package supports Node >=18; on Termux/Android it compiles from source because the upstream prebuilt matrix does not include Android. The built addon was validated on the current Termux Node runtime.
