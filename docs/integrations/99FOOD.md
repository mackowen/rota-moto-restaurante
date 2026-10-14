# 99Food protocol findings — 2026-10-14

## Official sources

- [99Food developer portal](https://developer-food.99app.com/)
- [99Food OpenAPI portal](https://developer-food.99app.com/pt-BR/openapi)
- [99Food order webhooks](https://openplatform-portal-food.99app.com/docs/v1/node/nodedataget?id=1981) — “Order API > Order Webhooks (Recommended)”.
- [99Food get order details](https://openplatform-portal-food.99app.com/docs/v1/node/nodedataget?id=1983) — “Order API > Get Order Details”.
- [99Food authentication and signature](https://openplatform-portal-food.99app.com/docs/v1/node/nodedataget?id=1925) — “Authentication & Signature Mechanism”.
- [99Food get auth token](https://openplatform-portal-food.99app.com/docs/v1/node/nodedataget?id=1929) and [refresh auth token](https://openplatform-portal-food.99app.com/docs/v1/node/nodedataget?id=1931).
- [99Food Orders module](https://openplatform-portal-food.99app.com/docs/v1/node/nodedataget?id=1919); [rate limits](https://openplatform-portal-food.99app.com/docs/v1/node/nodedataget?id=1923); [before coding](https://openplatform-portal-food.99app.com/docs/v1/node/nodedataget?id=1889); [before going live](https://openplatform-portal-food.99app.com/docs/v1/node/nodedataget?id=1891).
- [99Food Open Delivery adherent profile](https://aderentes.opendelivery.com.br/companies/68f696345e89f79a1563008a) — Order and Merchant marked ready to integrate, Logistics in development, sandbox available.
- [Open Delivery current reference](https://docs.opendelivery.com.br/en/reference/) and [Orders protocol](https://docs.opendelivery.com.br/en/protocol/orders/). The public reference distinguishes stable V1 1.7.0 from V2 2.0.0-rc. It is a separate protocol and is not the 99Food Protocol (Recommended).

The portal is a JavaScript application; exact 99Food pages were fetched from its official documentation API, not inferred from Open Delivery. The API reference identifies `https://openapi.99food.com` and versioned endpoint paths. Portal documents do not expose an unambiguous content revision date; consultation date above is recorded instead.

## Verified contract implemented locally

`backend/integrations/99food-protocol.js` implements a transport-injected protocol adapter and validators:

- Parameter signature: omit empty/sign fields, ASCII-sort keys, join `key=value` with `&`, append app secret, MD5 hex.
- Webhook signature: MD5 of the exact raw request bytes followed by app secret, compared in constant time against `didi-header-sign`.
- Webhook envelope: `app_id`, `app_shop_id`, integer Unix `timestamp`, `type`, and `data`. Recognized documented notifications are `orderNew`, `orderCancel`, `orderFinish`, `deliveryStatus`, `orderCancelApply`, `orderRefundApply`, and `orderPartialCancel`.
- Webhook events use a deterministic digest identity and retain the provider timestamp. `orderNew` and state notifications are fetch triggers; the fetched order detail is authoritative for complete order data. An inbox/runtime must deduplicate before acknowledging.
- Lossless parsing preserves unsafe integer IDs as strings as the portal requires for Long identifiers.
- Order detail maps documented status codes 100, 200, 400, 500, 600 and cancellation codes 901–981. Fulfillment uses `delivery_type` (0 pickup, 1 99Food delivery, 2 store delivery) and `fulfillment_mode` (0 delivery, 1 self pickup). The adapter never creates an operational Delivery.
- Documented calls include GET `/v1/order/order/detail`, POST `/v1/order/order/confirm`, `/v1/order/order/ready`, `/v1/order/order/delivered` (self-delivery only), and `/v1/order/order/cancel` with the documented reason IDs.
- Auth token routes are `/v1/auth/authtoken/get` and `/v1/auth/authtoken/refresh`; the published guide says token expiry is random and refresh has a two-minute cooldown. The account resolver stores tokens in the existing protected secret store; the PostgreSQL refresh lease prevents parallel refreshes and holds for 135 seconds.
- Public rate table: order detail 10 per 10 seconds; confirm, ready, delivered, cancel, and cancellation/refund response 5 per second; get/refresh token 1 per 30 seconds. Provider error envelope contains `errno`, `errmsg`, optional `requestId`, `time`, and `data`; published errors include 10001, 10002, 10100–10102, 14103, 14105, and 14106 for token acquisition.
- Webhook response must be JSON `{ "errno": 0, "errmsg": "ok" }`; portal callback timeout is 6 seconds and nonzero `errno` causes retries.

The portal's request-signature guidance is MD5 parameter signing, while webhook signing is explicitly raw-body-plus-secret. They are implemented separately. No auth, webhook or order request was sent to 99Food during the 0152 contract research.

## Current runtime status — 2026-10-14

The 0152 adapter is now connected to the existing account, webhook, inbox, canonical Order, sync outbox, command worker, and unified-order flows. Migrations 0042–0044 support the provider, and official development database `rotamoto` is at schema version 0044. The same migrations are present in `rotamoto_e2e`. Runtime, unit, PostgreSQL worker/rate-limit, and Chromium/CDP desktop/mobile tests use synthetic fixtures; no commercial provider request was sent.

Migration 0044 adds PostgreSQL-coordinated per-application and per-store operation buckets. Detail calls are spaced to enforce the published 10/10-second limit; order commands use 200 ms spacing (at most five per second); token get and refresh each use a 30-second bucket. Hash keys are opaque, table reads are denied to app/worker, RLS and FORCE RLS are enabled, and the `SECURITY DEFINER` claim function has a fixed `search_path`. HTTP `Retry-After` supports both delay-seconds and HTTP-date forms. A provider 429 is returned to the durable worker retry policy; ambiguous 5xx side effects are not blindly retried.

The development runtime is **READY_FOR_EXTERNAL_HOMOLOGATION = YES** for the locally implemented 99Food Protocol (Recommended) surface. This does not state that 99Food accepted or certified the integration. No live connection is enabled without provisioned credentials and external authorization.

## Remaining external dependencies

The public portal also requires partner qualification/NDA, app credentials, merchant authorization/binding, certification, and production whitelisting for some data (including promotions). Those are external blockers. The 99Food Protocol documents order webhooks, not polling; polling in Open Delivery is not attributed to 99Food's separate protocol. Provider logistics quote, dispatch, courier tracking, and delivery cancellation are not documented as integrator APIs in the reviewed order contract. Store delivery is represented only as fulfillment responsibility; it must later use RotaMoto's own existing Delivery flow after runtime wiring.

The contract fixture tests do not establish sandbox acceptance or commercial homologation.
