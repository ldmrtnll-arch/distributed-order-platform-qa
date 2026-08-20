# Test Strategy

## Objective and scope

Provide fast feedback and evidence that the distributed Order workflow remains correct across API contracts, owned databases, synchronous dependencies, asynchronous messaging, failures, concurrency, and moderate performance. Scope covers Inventory, Payment, Order, Notification, PostgreSQL, and RabbitMQ.

## Test layers

| Layer | Focus | Main location |
| --- | --- | --- |
| Static | TypeScript/NodeNext compatibility and build | Workspace scripts |
| API | Public contracts, validation, headers, errors, idempotency | `tests/api` |
| Database | Persistence, constraints, timestamps, cross-service consistency | `tests/database` |
| Contract | Executable terminal event JSON Schema | `tests/events/contracts` |
| Integration/event | Real services, Outbox, RabbitMQ, Notification, DLQ | `tests/events` |
| Resilience | Database, dependency, broker, and consumer outages/recovery | `tests/resilience` and event resilience |
| Performance | Smoke, paced load, concurrency/idempotency, async consistency | `performance` |

API/database tests form the broad fast layer. Fewer serial event and resilience scenarios cover costly infrastructure behavior. Performance is deliberately narrow and workflow-focused.

## Automation and CI

Pull requests and `main` run static quality, normal tests, event tests, and K6 smoke. Destructive resilience and moderate load remain manual workflows to avoid parallel infrastructure interference and unnecessary runner consumption. Reports are retained as temporary artifacts.

## Data and isolation

Functional tests use scenario-specific SKUs and idempotency keys. Event suites use exclusive fixtures and purge only their two RabbitMQ queues. Performance uses only `PERF-%`, checks five persistence stages, and performs selective cleanup in `finally`. Fixed waits are not used for synchronization; bounded polling observes health and eventual consistency.

## Entry criteria

* PostgreSQL and RabbitMQ containers are healthy;
* required ports are free for exclusive suites;
* dependencies are installed from `package-lock.json`;
* migrations and controlled fixtures can be applied.

## Exit criteria

* typecheck and build pass;
* applicable functional, event, and resilience suites pass;
* K6 checks, error-rate, and latency thresholds pass;
* cross-database/event counts converge;
* selective cleanup leaves no test processes or messages.

## Exclusions and risks

No UI, authentication, real payments, real notifications, production capacity, chaos platform, cloud deployment, or exactly-once guarantee is tested. Detailed risks and mitigations are maintained in [Risks and Limitations](risks-and-limitations.md).
