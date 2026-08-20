# Distributed Order Platform — QA Portfolio Project

[![CI](https://github.com/ldmrtnll-arch/distributed-order-platform-qa/actions/workflows/ci.yml/badge.svg)](https://github.com/ldmrtnll-arch/distributed-order-platform-qa/actions/workflows/ci.yml)

## Overview

Portfolio laboratory for testing a distributed order-processing platform. It demonstrates practical Quality Engineering across REST APIs, independent databases, synchronous microservice integration, asynchronous events, controlled failures, performance, and CI/CD.

**QA focus:** API Testing · Integration Testing · Database Testing · Event-Driven Testing · Resilience Testing · Performance Testing · CI/CD

The badge reflects GitHub's live result. The workflow was validated successfully on the final project pull request.

## Architecture

The client calls Order, which synchronously reserves Inventory and processes Payment. Every terminal Order transition creates an event in a transactional Outbox. A background publisher sends it through RabbitMQ and Notification validates and persists it idempotently.

```text
Synchronous request flow
Client -> Order -> Inventory -> inventory_db
                -> Payment   -> payments_db

Asynchronous terminal-event flow
Order transaction -> orders_db + Transactional Outbox
                  -> RabbitMQ -> Notification -> notifications_db
```

The main path is `POST /orders` → Inventory reservation → Payment → `CONFIRMED` → Outbox → RabbitMQ → Notification. Inventory rejection ends as `INVENTORY_REJECTED`; Payment decline releases Inventory and ends as `PAYMENT_DECLINED`; a release failure ends as `COMPENSATION_FAILED`.

See [System Architecture](docs/architecture.md) for state transitions, delivery semantics, topology, and trade-offs.

## Quality scope

* API contracts, validation, error safety, headers, and status codes;
* PostgreSQL constraints and cross-database consistency;
* idempotent replay and concurrent requests;
* Inventory rejection, Payment decline, and compensation;
* JSON Schema event contracts and correlation IDs;
* Transactional Outbox, at-least-once delivery, duplicate consumption, ACK/NACK, and DLQ;
* database, dependency, consumer, and RabbitMQ resilience;
* K6 smoke, moderate load, and concurrency/idempotency performance;
* GitHub Actions quality, functional, event, resilience, and performance pipelines.

## Why these tests matter

* Idempotency and concurrency checks prove that retries and simultaneous requests do not duplicate business effects.
* Direct database assertions verify constraints and distributed side effects that an HTTP response alone cannot prove.
* Business rejections are distinguished from technical outages because they require different states, responses, and recovery behavior.
* Cross-service checks validate Order, Inventory, Payment, Outbox, RabbitMQ, and Notification as one observable workflow without assuming a global transaction.
* Scenario-owned fixtures and `finally` cleanup keep parallel runs independent and preserve cleanup after assertion failures.
* Bounded polling observes health and eventual consistency without fragile fixed waits.
* Resilience suites are serial because they deliberately control shared ports, processes, and containers.
* K6 thresholds provide a repeatable regression baseline for the documented laboratory profile, not a production capacity claim.

## Technologies

TypeScript, Node.js, Express, Playwright, PostgreSQL, RabbitMQ, Docker Compose, JSON Schema/Ajv, K6, and GitHub Actions.

## Quick start

Prerequisites: Git, Node.js 22+, npm 10+, and Docker Desktop or Docker Engine with Compose. K6 runs in Docker and does not need a global installation.

```text
git clone https://github.com/ldmrtnll-arch/distributed-order-platform-qa.git
cd distributed-order-platform-qa
npm ci
```

Copy `.env.example` to `.env`, then start infrastructure and wait for real health checks:

```text
Copy-Item .env.example .env
docker compose up -d
npm run infra:wait
```

On a POSIX shell, use `cp .env.example .env` instead of `Copy-Item`.

Static and functional validation:

```text
npm run typecheck
npm run build
npm test
npm run test:events
npm run test:resilience
```

Performance validation requires Docker but no global K6 installation:

```text
npm run test:performance:smoke
npm run test:performance:load
npm run test:performance:concurrency
```

Dedicated data commands are available as `performance:prepare`, `performance:verify`, and `performance:cleanup`. Stop infrastructure with `npm run docker:down` when it is no longer needed.

## Test suites

| Suite | Purpose | Execution model |
| --- | --- | --- |
| Normal | API and database behavior | Parallel Playwright workers |
| Events | Contracts, E2E delivery, duplicates, DLQ, broker/consumer recovery | Serial, controlled processes |
| Resilience | PostgreSQL and dependency outages | Serial aggregate; infrastructure exclusive |
| Performance | Smoke, paced load, concurrent idempotent pairs | Docker K6; dedicated `PERF-%` data |

The performance runner starts ports 3001–3004 itself, polls health, checks eventual consistency, stops only its child processes, and cleans its records and RabbitMQ queues in `finally`.

## CI/CD

* `ci.yml` runs typecheck/build, normal Playwright, event tests, and K6 smoke on pull requests and pushes to `main`.
* `resilience.yml` runs the three destructive resilience suites serially through manual dispatch.
* `performance.yml` runs smoke, load, and concurrency through manual dispatch.

Jobs use Node 22, `npm ci`, Docker Compose health polling, explicit timeouts, cancellation of superseded runs, failure-only infrastructure diagnostics, and unconditional Compose cleanup. Browser binaries are not installed because Playwright is used only as an API runner.

## Reports

Playwright HTML reports and generated K6 summaries/service logs are uploaded as GitHub Actions artifacts for 10 days. Generated local output under `artifacts/`, `playwright-report/`, and `test-results/` is ignored by Git.

Consolidated evidence is available in:

* [Performance Report](docs/performance-report.md)
* [Test Execution Report](docs/test-execution-report.md)
* [Test Strategy](docs/test-strategy.md)
* [Test Plan](docs/test-plan.md)
* [Traceability Matrix](docs/traceability-matrix.md)
* [Risks and Limitations](docs/risks-and-limitations.md)
* [Bug Reports](docs/bug-reports.md)
* [Project Status](docs/project-status.md)

## Known limitations

The project does not claim production capacity or exactly-once delivery. It has no global event ordering, exponential-backoff/delay queues, real payment provider, real e-mail/SMS, automatic compensation retry, full distributed tracing, authentication, cloud deployment, or multi-node PostgreSQL/RabbitMQ. All performance results describe one local laboratory environment only.
