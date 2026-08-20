# Distributed Order Platform QA

Quality Assurance portfolio project for a distributed order-processing platform composed of REST APIs, independent PostgreSQL databases, RabbitMQ messaging, and controlled failure scenarios.

## Project status

The repository implements and tests Inventory, Payment, Order, and Notification services. Order synchronously reserves Inventory, processes Payment, and compensates Inventory after a business decline. Every terminal Order transition also creates a versioned event in a transactional Outbox; a background publisher delivers it through RabbitMQ, and Notification consumes and persists it idempotently.

See [System Architecture](docs/architecture.md) and [Project Status](docs/project-status.md) for design details and executed evidence.

## Order workflow

`POST /orders` persists an Order as `PENDING`, calls Inventory and Payment over REST, propagates `X-Correlation-Id`, and uses deterministic internal idempotency keys. The terminal states and events are:

| Order status | Event type | Routing key |
| --- | --- | --- |
| `CONFIRMED` | `ORDER_CONFIRMED` | `order.confirmed` |
| `INVENTORY_REJECTED` | `ORDER_INVENTORY_REJECTED` | `order.inventory_rejected` |
| `PAYMENT_DECLINED` | `ORDER_PAYMENT_DECLINED` | `order.payment_declined` |
| `COMPENSATION_FAILED` | `ORDER_COMPENSATION_FAILED` | `order.compensation_failed` |

`PENDING` and `INVENTORY_RESERVED` remain recoverable and do not produce terminal events. Replaying a terminal request returns the existing result without a second event. Conditional updates plus a database uniqueness constraint protect the same guarantee under concurrency.

## Asynchronous delivery

The terminal status update and insertion into `order_outbox_events` commit in the same `orders_db` transaction. A non-blocking publisher reads pending rows in `created_at` order, publishes persistent messages with publisher confirms and mandatory routing, and only then sets `published_at`. Failures leave the row pending, increment `publish_attempts`, and store only a sanitized category.

RabbitMQ uses the durable topic exchange `order.events`, durable queue `notification.order-events`, dead-letter exchange `order.events.dlx`, and durable DLQ `notification.order-events.dlq`. The publisher provisions this topology before sending, so an unroutable message is not silently considered successful.

Notification validates the shared [Order event v1 schema](contracts/events/order-event.v1.schema.json) with Ajv before persistence. It uses manual acknowledgement after the database commit. Invalid messages are rejected without requeue and reach the DLQ; transient persistence failures are requeued and the consumer reconnects instead of creating a hot retry loop. A unique `event_id` makes duplicate delivery safe.

## Running the project

Start PostgreSQL and RabbitMQ:

```powershell
npm run docker:up
```

Run the normal API/database suite:

```powershell
npm test
```

Run the serialized event and messaging suite, which controls service processes and RabbitMQ availability:

```powershell
npm run test:events
```

Run the existing resilience suites separately:

```powershell
npm run test:resilience:order
npm run test:resilience:inventory
npm run test:resilience:payment
```

Validate all workspaces:

```powershell
npm run typecheck
npm run build
```

The normal suite intentionally excludes `tests/events/**` and `tests/resilience/**`. Those tests run serially because they take exclusive control of service ports or infrastructure availability. PostgreSQL and RabbitMQ must be healthy before they start, and their teardown restores the broker and stops only processes created by the tests.

## Technology

* Node.js and TypeScript with ES Modules/NodeNext
* Express
* Playwright
* PostgreSQL
* RabbitMQ with `amqplib`
* JSON Schema and Ajv
* Docker Compose

## Delivery semantics and trade-offs

Transactional Outbox avoids the inconsistent dual write in which an Order commits but its RabbitMQ publication is lost. Delivery is intentionally **at least once**, not exactly once; duplicates remain possible and are neutralized by `notifications.event_id UNIQUE`. Publisher confirms protect broker acceptance, mandatory routing protects queue delivery, and the DLQ prevents invalid messages from looping.

The current scope does not provide global event ordering, real e-mail or SMS, delayed queues, exponential backoff, complete distributed tracing, or automatic compensation retry. Ordering is deterministic for the publisher's pending batch, but ordering between different Orders is not guaranteed.

## Security boundary

Events and Notifications carry only the terminal business data and correlation ID needed by the consumer. They exclude payment tokens, external and internal idempotency keys, reservation/payment IDs, request fingerprints, credentials, connection strings, SQL, and stack traces. Health responses and normal structured logs do not expose infrastructure secrets.
