# Project Status

## Completed scope

* Docker Compose infrastructure with healthy PostgreSQL and RabbitMQ services.
* Independent Inventory, Payment, Order, and Notification TypeScript services.
* Synchronous Order-to-Inventory-to-Payment orchestration and Inventory compensation.
* Terminal Order states `CONFIRMED`, `INVENTORY_REJECTED`, `PAYMENT_DECLINED`, and `COMPENSATION_FAILED`.
* Versioned terminal Order contract in JSON Schema, validated at runtime with Ajv.
* Transactional Outbox in `orders_db`, created atomically with each terminal state.
* RabbitMQ topic exchange, publisher confirms, mandatory routing, retry, and reconnect.
* Persistent Notification consumer with manual ACK, idempotency by `event_id`, and DLQ handling.
* Correlation ID propagation from the producing HTTP request through Outbox, event, and Notification.
* Recovery when RabbitMQ or Notification is unavailable, without replaying the client request.
* API, database, contract, duplicate-delivery, poison-message, concurrency, and resilience coverage.
* K6 smoke, moderate-load, and concurrent-idempotency scenarios with dedicated data and cross-database post-condition checks.
* GitHub Actions for quality, normal API/database tests, event delivery, performance smoke, manual resilience, and manual full performance.
* Consolidated test strategy, plan, traceability, risks, bug reports, performance results, and execution evidence.

## Current implementation boundary

Order's Inventory and Payment orchestration remains synchronous; terminal notifications are asynchronous. RabbitMQ availability does not make Order unhealthy or prevent a completed business response because pending Outbox rows recover later. Notification health depends on both `notifications_db` and RabbitMQ.

The implementation provides at-least-once delivery, not exactly-once. A Notification is simulated as a persisted stable message; there is no real e-mail, SMS, global ordering guarantee, delayed retry queue, exponential backoff, full distributed tracing, or automatic recovery of `COMPENSATION_FAILED`.

## Test execution evidence

Results executed on 2026-08-20 while finalizing Order events and Notification:

| Suite | Command | Result |
| --- | --- | --- |
| TypeScript workspaces | `npm run typecheck` | 5 workspaces passed |
| Build workspaces | `npm run build` | 5 workspaces passed |
| Order API and database | targeted Playwright run | 44 passed in 4.2s |
| Inventory API and database | targeted Playwright run | 49 passed in 4.0s |
| Payment API and database | targeted Playwright run | 30 passed in 3.6s |
| Normal Playwright suite | `npm test` | 123 passed in 5.2s |
| Event/Notification suite, run 1 | `npm run test:events` | 21 passed in 16.8s |
| Event/Notification suite, run 2 | `npm run test:events` | 21 passed in 16.8s |
| Order resilience | `npm run test:resilience:order` | 10 passed in 24.3s |
| Inventory resilience | `npm run test:resilience:inventory` | 2 passed in 17.5s |
| Payment resilience | `npm run test:resilience:payment` | 1 passed in 8.9s |

The normal Playwright configuration excludes `tests/events/**` and `tests/resilience/**`. Messaging and infrastructure-failure suites use one worker because they control service ports and dependency availability.

The finalization baseline and post-change results are consolidated in [Test Execution Report](test-execution-report.md). The measured local K6 smoke, load, and concurrency results, including thresholds and environment limitations, are in [Performance Report](performance-report.md). GitHub workflows are configured, but this document does not claim a remote result before GitHub executes them.

## Event delivery evidence

* All four terminal states produce the matching version 1 event; recoverable states do not.
* The terminal Order update and Outbox insert share one PostgreSQL transaction.
* HTTP replay and concurrent creation finish with one Order, one Outbox event, and one Notification.
* `ORDER_CONFIRMED`, `ORDER_INVENTORY_REJECTED`, and `ORDER_PAYMENT_DECLINED` were exercised through the real Order workflow.
* `ORDER_COMPENSATION_FAILED` was exercised with a controlled Inventory release failure and delivered to Notification.
* Duplicate RabbitMQ delivery is ACKed and leaves one Notification row.
* Invalid JSON/schema data is not persisted, reaches the DLQ, and does not stop later valid consumption.
* Notification downtime accumulates a durable queue message and consumes it after restart.
* RabbitMQ downtime leaves a pending Outbox event while Order still returns `201 CONFIRMED`; broker recovery publishes and consumes it without another client request.

## Problems found and corrected

* Ajv strict mode rejected conditional schema branches without an explicit object type. The shared schema was corrected rather than weakening validation.
* The default Playwright config initially discovered the new exclusive event suites, causing port contention. `tests/events/**` is now excluded from the normal config and remains available through `npm run test:events`.
* The existing Order database-outage test initially rejected the publisher's new sanitized `publish-order-events` log. Its operation whitelist was extended while retaining secret/stack checks.
* Publisher shutdown originally closed the AMQP channel before an active poll completed. Shutdown now waits for the poll before closing its known resources.
* Docker K6 initially could not reach the host on Windows because an explicit host-gateway alias replaced Docker Desktop's native mapping. The runner now uses native `host.docker.internal` on Windows and host networking on Linux.

## Decisions

* Transactional Outbox is used instead of publishing directly from the HTTP request.
* Publisher success requires a positive RabbitMQ confirm; `published_at` remains null on failure.
* Topology is provisioned before publishing and messages use `mandatory: true`.
* Delivery is at least once; `notifications.event_id UNIQUE` provides consumer idempotency.
* Invalid messages use `nack(requeue=false)` and the DLQ; transient database failures use requeue plus reconnect to avoid a hot loop.
* Terminal event uniqueness is enforced by `order_outbox_events.aggregate_id UNIQUE` for the current one-terminal-event-per-Order model.
* Only per-Order batch order is read deterministically; no global ordering is promised.
* Laboratory thresholds are `http_req_failed < 1%`, functional checks and confirmed Orders above 99%, p95 below 750 ms, and p99 below 1500 ms; they are regression criteria, not production SLOs.
* Resilience and the full K6 sequence are manually dispatched in CI because they are infrastructure-exclusive or intentionally heavier than pull-request feedback.

## Next steps

1. Observe the first remote GitHub Actions runs and tune only evidence-based runner-specific issues.
2. Use the documented suites and reports during portfolio review and technical interviews.
3. Treat production observability, deployment, and external-provider integrations as future projects rather than expanding this QA portfolio branch.
