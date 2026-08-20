# Project Status

## Completed scope

* Docker Compose infrastructure with healthy PostgreSQL and RabbitMQ services.
* Independent Inventory, Payment, and Order services using TypeScript and PostgreSQL.
* Inventory lookup, reservation, release, idempotency, concurrency, database, and resilience coverage.
* Payment approval/decline, idempotency, concurrency, database, and resilience coverage as an independent service.
* Order creation, validation, idempotency conflicts, and database consistency coverage.
* Synchronous Order-to-Inventory reservation through REST.
* Propagation of `X-Correlation-Id` and internal Inventory idempotency key `order:<orderId>:inventory-reservation`.
* Order state transitions from `PENDING` to `INVENTORY_RESERVED` or terminal `INVENTORY_REJECTED`.
* Recoverable `PENDING` state for Inventory unavailability, timeout, unexpected `409`, and invalid success contract.
* Idempotent recovery, concurrent Order creation, and cross-database consistency validation.

## Current implementation boundary

Order currently orchestrates only the Inventory reservation stage. Payment is implemented and tested separately, but is not called by Order. RabbitMQ is running as infrastructure; event publication, consumers, compensation, and Notification Service are not implemented yet.

## Test execution evidence

Results executed on 2026-08-20 while finalizing the Order-to-Inventory integration:

| Suite | Command | Result |
| --- | --- | --- |
| TypeScript workspaces | `npm run typecheck` | 4 workspaces passed |
| Order resilience, run 1 | `npm run test:resilience:order` | 5 passed in 14.7s |
| Order resilience, run 2 | `npm run test:resilience:order` | 5 passed in 14.4s |
| Order API | `npx playwright test --config tests/playwright.config.ts tests/api/order/orders.spec.ts` | 38 passed in 3.9s |
| Order database | `npx playwright test --config tests/playwright.config.ts tests/database/order/orders-database.spec.ts` | 3 passed in 3.6s |
| Normal Playwright suite | `npm test` | 121 passed in 4.5s |

The normal Playwright configuration intentionally excludes `tests/resilience/**`. Infrastructure-failure tests run with one worker because they take exclusive control of service ports and PostgreSQL availability.

## Order resilience scenarios

* Order health degrades to `503` while its database is stopped and recovers without restarting the process.
* Inventory unavailable leaves one recoverable `PENDING` Order and no reservation, then succeeds with the same idempotency key.
* A real 200ms Inventory timeout produces one outbound request, no implicit retry, and successful recovery against real Inventory.
* An unexpected Inventory idempotency-conflict `409` is treated as technical failure rather than `INVENTORY_REJECTED`.
* A `201` response with an invalid reservation body is rejected as an incompatible dependency contract.
* Each recovery uses a new correlation ID while preserving the Order fingerprint and propagates the current correlation ID to Inventory.
* Terminal replay preserves one Order, one reservation, and `reserved_quantity = 2` rather than incrementing it to `4`.

## Problems found and learnings

An earlier cross-database suite used a global `afterAll` assertion while its tests ran in parallel workers. One worker could observe another worker's still-active fixture, causing a race condition despite correct cleanup. The global assertion was replaced with cleanup and residual-state validation isolated to each scenario.

No backend defect was found during the resilience implementation. The existing Order client already classified transport failures, timeout, unexpected status, and invalid response bodies as technical Inventory failures while preserving `PENDING`.

## Next steps

1. Integrate Payment into the Order workflow.
2. Implement compensation when a later workflow stage fails.
3. Publish and validate RabbitMQ domain events.
4. Implement Notification Service and consumer idempotency.
5. Add contract schemas, CI execution, and broader performance coverage.

## Decisions

* Each service owns its logical PostgreSQL database.
* Technical Inventory failures keep an Order recoverable as `PENDING`.
* Recognized Inventory business failures are terminal as `INVENTORY_REJECTED`.
* Correlation ID is traceability metadata and does not participate in the Order request fingerprint.
* No automatic Inventory retry is implemented yet.
* Test results are documented only after actual execution.
