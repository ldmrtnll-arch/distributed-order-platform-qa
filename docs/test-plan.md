# Test Plan

## Components and environment

The plan covers Order, Inventory, Payment, Notification, four logical PostgreSQL databases, and RabbitMQ. Local execution uses Docker Compose for infrastructure and Node child processes for services. GitHub-hosted Ubuntu runners reproduce the same Compose setup.

## Scenarios

* create, validate, replay, conflict, and concurrently create Orders;
* reserve/release Inventory and prevent overselling;
* approve/decline Payment without duplicate processing;
* compensate Inventory and expose controlled compensation failure;
* create terminal Outbox events atomically and validate their schema;
* consume idempotently, ACK/NACK safely, and dead-letter poison messages;
* recover from unavailable databases, dependencies, consumer, and broker;
* measure approved Order smoke, load, and concurrent replay.

## Data

Functional and resilience fixtures have dedicated SKUs and generated UUID-based keys. Performance uses `PERF-ORDER-001` and `PERF-ORDER-002`, each with 10,000 units. Cleanup selects known order IDs/SKU prefixes; no unfiltered production-style deletion is used by performance scripts.

## Tools and deliverables

Playwright provides API/integration execution, `pg` validates persistence, Ajv validates JSON Schema, amqplib controls RabbitMQ, K6 captures performance metrics, and GitHub Actions orchestrates pipelines. Deliverables are source tests, workflows, HTML/K6 artifacts, this plan, strategy, matrix, risk register, bug reports, and execution reports.

## Pass/fail criteria

Functional checks and expected persistence must be exact. Resilience must demonstrate both outage behavior and recovery. K6 must satisfy checks >99%, HTTP errors <1%, p95 <750 ms, and p99 <1500 ms in the defined laboratory scenarios. Any cleanup or process leak blocks completion.

## Execution order

Run static quality, normal tests, events, resilience serially, then performance with healthy infrastructure and free service ports. Audit data, queues, ports, processes, and Git state after execution.

## Risks

Exclusive suites can conflict when run concurrently, local performance varies by hardware, and shared infrastructure outages affect multiple logical databases. CI separates or serializes these workloads and applies explicit job timeouts.
