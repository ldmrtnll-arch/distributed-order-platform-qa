# Distributed Order Platform QA

Quality Assurance portfolio project for a distributed order-processing platform composed of REST APIs, independent PostgreSQL databases, and infrastructure prepared for asynchronous messaging.

## Project status

The repository currently implements and tests the Inventory, Payment, and Order services. The active end-to-end workflow is limited to the synchronous integration from Order Service to Inventory Service; Payment is tested as an independent service and is not yet part of the Order workflow. RabbitMQ is available in the local infrastructure, but domain-event publishing and Notification Service remain future work.

See [System Architecture](docs/architecture.md) and [Project Status](docs/project-status.md) for the implemented scope and remaining work.

## Implemented Order to Inventory flow

`POST /orders` persists an Order as `PENDING` and calls `POST /reservations` synchronously. Order propagates `X-Correlation-Id` and protects the dependency call with the internal idempotency key `order:<orderId>:inventory-reservation`.

The current state transitions are:

* `PENDING -> INVENTORY_RESERVED` when Inventory creates or replays the reservation;
* `PENDING -> INVENTORY_REJECTED` for terminal business outcomes: unknown SKU or insufficient stock;
* `PENDING` remains recoverable when Inventory is unavailable, times out, returns an unexpected status, or violates the success response contract.

A client can recover a technical failure by replaying the same payload and `Idempotency-Key`. The existing Order is reused, a new correlation ID may be supplied, and stock is reserved only once. There is no automatic Inventory retry in the Order Service at this stage.

## Automated coverage

The Playwright suites cover:

* Inventory, Payment, and Order API contracts;
* idempotent replay and idempotency conflicts;
* inventory business rejection and stock concurrency;
* Order and Inventory cross-database consistency;
* dependency unavailability, timeout, unexpected responses, and recovery;
* correlation-ID propagation and internal reservation idempotency;
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

The Order resilience suite controls ports `3001` and `3002`, and starts/stops only the service processes it creates. PostgreSQL and RabbitMQ must be healthy before execution.

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

The complete target architecture includes Payment orchestration, compensation, RabbitMQ domain events, and Notification Service. Those components must not be interpreted as already integrated into the current Order workflow.
