# Project Status

## Completed scope

* Docker Compose infrastructure with healthy PostgreSQL and RabbitMQ services.
* Independent Inventory, Payment, and Order services using TypeScript and PostgreSQL.
* Inventory lookup, reservation, release, idempotency, concurrency, database, and resilience coverage.
* Payment approval/decline, idempotency, concurrency, database, and resilience coverage.
* Order creation, validation, idempotency conflicts, concurrency, and database consistency coverage.
* Synchronous Order-to-Inventory-to-Payment orchestration through REST.
* Approved Payment transition to terminal `CONFIRMED`.
* Payment business decline compensation through Inventory release and terminal `PAYMENT_DECLINED`.
* Terminal `COMPENSATION_FAILED` when Inventory release fails technically.
* Propagation of `X-Correlation-Id` to Inventory reservation, Payment, and Inventory release.
* Deterministic internal idempotency keys for Inventory reservation, Payment, and Inventory release.
* Recoverable `PENDING` state for Inventory technical failures and recoverable `INVENTORY_RESERVED` state for Payment technical failures.
* Idempotent recovery and cross-database consistency across `orders_db`, `inventory_db`, and `payments_db`.

## Current implementation boundary

Order synchronously orchestrates Inventory reservation, Payment, and release compensation. RabbitMQ is running as infrastructure, but event publication, consumers, and Notification Service are not implemented. `COMPENSATION_FAILED` is terminal in this increment; automatic compensation retry is not implemented yet.

## Test execution evidence

Results executed on 2026-08-20 while finalizing the Order-to-Payment integration:

| Suite | Command | Result |
| --- | --- | --- |
| TypeScript workspaces | `npm run typecheck` | 4 workspaces passed |
| Order API and database | targeted Playwright run | 43 passed in 4.0s |
| Payment API and database | targeted Playwright run | 30 passed in 3.5s |
| Inventory API and database | targeted Playwright run | 49 passed in 3.7s |
| Order resilience, run 1 | `npm run test:resilience:order` | 10 passed in 23.6s |
| Order resilience, run 2 | `npm run test:resilience:order` | 10 passed in 23.7s |
| Payment resilience | `npm run test:resilience:payment` | 1 passed in 8.9s |
| Inventory resilience | `npm run test:resilience:inventory` | 2 passed in 17.0s |
| Normal Playwright suite | `npm test` | 123 passed in 4.4s |

The normal Playwright configuration intentionally excludes `tests/resilience/**`. Infrastructure-failure tests run with one worker because they take exclusive control of service ports and PostgreSQL availability.

## Order workflow evidence

* Approved Payment produces `CONFIRMED` with one Order, one `RESERVED` Inventory reservation, one `APPROVED` Payment, and consistent foreign identifiers.
* Terminal replay does not update timestamps or duplicate effects; concurrent calls also finish with one Order, one reservation, one Payment, and stock reserved once.
* The four payload conflicts return `409` without additional Order, Inventory, or Payment effects.
* Unknown SKU and insufficient stock produce `INVENTORY_REJECTED` without calling or persisting Payment.
* `CARD_DECLINED` and `PAYMENT_METHOD_REJECTED` persist a declined Payment, release the reservation, restore stock, and produce `PAYMENT_DECLINED`.
* Payment network failure, timeout, invalid success contract, and unexpected `500` preserve `INVENTORY_RESERVED`; recovery confirms the same Order without another reservation.
* A controlled Inventory release failure produces `COMPENSATION_FAILED`, preserves the declined Payment and reserved stock, and is terminal on replay.
* Mock assertions verify one Payment request on timeout and propagation of the current correlation ID and internal idempotency keys.

## Problems found and learnings

The initial Order API expectation correctly failed after the backend began returning `CONFIRMED` instead of the previous `INVENTORY_RESERVED`; the test contract was then evolved to validate all three databases. No unrelated service defect was found. A TypeScript `exactOptionalPropertyTypes` error in the new resilience helper was corrected by omitting an unset timeout option instead of explicitly passing `undefined`.

## Next steps

1. Publish and validate RabbitMQ domain events.
2. Implement Notification Service and consumer idempotency.
3. Design an explicit retry policy for `COMPENSATION_FAILED`.
4. Add contract schemas, CI execution, and broader performance coverage.

## Decisions

* Each service owns its logical PostgreSQL database.
* `PENDING` and `INVENTORY_RESERVED` are recoverable states.
* `INVENTORY_REJECTED`, `CONFIRMED`, `PAYMENT_DECLINED`, and `COMPENSATION_FAILED` are terminal states.
* Payment business decline triggers Inventory release; Payment technical failure does not release Inventory.
* Correlation ID is traceability metadata and does not participate in the Order request fingerprint.
* Internal keys are `order:<orderId>:inventory-reservation`, `order:<orderId>:payment`, and `order:<orderId>:inventory-release`.
* No automatic dependency retry is implemented.
* Test results are documented only after actual execution.
