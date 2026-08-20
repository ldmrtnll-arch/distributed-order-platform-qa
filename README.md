# Distributed Order Platform QA

Quality Assurance portfolio project for a distributed order-processing platform composed of REST APIs, independent PostgreSQL databases, and infrastructure prepared for asynchronous messaging.

## Project status

The repository currently implements and tests the Inventory, Payment, and Order services. The active synchronous workflow reserves Inventory, processes Payment, confirms approved orders, and compensates Inventory after a business decline. RabbitMQ is available in the local infrastructure, but domain-event publishing and Notification Service remain future work.

See [System Architecture](docs/architecture.md) and [Project Status](docs/project-status.md) for the implemented scope and remaining work.

## Implemented Order workflow

`POST /orders` persists an Order as `PENDING`, calls `POST /reservations`, and then calls `POST /payments`. Order propagates `X-Correlation-Id` and protects dependency calls with deterministic internal idempotency keys: `order:<orderId>:inventory-reservation`, `order:<orderId>:payment`, and `order:<orderId>:inventory-release`.

The current state transitions are:

* `PENDING -> INVENTORY_RESERVED` when Inventory creates or replays the reservation; this state remains recoverable while Payment is unfinished;
* `PENDING -> INVENTORY_REJECTED` for terminal business outcomes: unknown SKU or insufficient stock;
* `INVENTORY_RESERVED -> CONFIRMED` when Payment is approved;
* `INVENTORY_RESERVED -> PAYMENT_DECLINED` after a Payment business decline and successful Inventory release;
* `INVENTORY_RESERVED -> COMPENSATION_FAILED` when Payment is declined but Inventory release fails technically.

A client can recover a technical Inventory or Payment failure by replaying the same payload and external `Idempotency-Key`. The existing Order is reused, a new correlation ID may be supplied, and neither stock nor Payment is duplicated. There is no automatic dependency retry. `COMPENSATION_FAILED` is terminal in the current increment, and automatic compensation retry is not implemented yet.

## Automated coverage

The Playwright suites cover:

* Inventory, Payment, and Order API contracts;
* idempotent replay and idempotency conflicts;
* inventory business rejection and stock concurrency;
* Order, Inventory, and Payment cross-database consistency;
* Inventory and Payment dependency unavailability, timeout, unexpected responses, incompatible contracts, and recovery;
* Payment-decline compensation and controlled compensation failure;
* correlation-ID propagation and internal reservation, payment, and release idempotency;
* validation, safe public errors, and database constraints.

Start the project infrastructure and run the normal suite with:

```powershell
npm run docker:up
npm test
```

Run the serialized Order resilience suite separately with:

```powershell
npm run test:resilience:order
```

Type-check every workspace with:

```powershell
npm run typecheck
```

The Order resilience suite controls ports `3001`, `3002`, `3003`, and the mock-only port `3004`, and starts/stops only the service processes it creates. PostgreSQL and RabbitMQ must be healthy before execution.

## Technology

* Node.js and TypeScript with ES Modules/NodeNext
* Express
* Playwright
* PostgreSQL
* RabbitMQ
* Docker Compose

## Main quality risks

The project focuses on duplicate processing, inconsistent cross-service state, dependency failures, incompatible contracts, incorrect retry behavior, concurrency, missing traceability, and sensitive information in public responses or logs.

## Scope boundary

RabbitMQ domain events, Notification Service, and automatic retry of failed compensation remain outside the current Order workflow. No real payment provider or financial transaction is used.
