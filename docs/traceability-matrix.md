# Traceability Matrix

| Requirement | Behavior | Automated evidence | Type | Status |
| --- | --- | --- | --- | --- |
| REQ-ORDER-001 | Create and validate an Order | `tests/api/order/orders.spec.ts` | API | Covered |
| REQ-IDEM-001 | Replay/conflict/concurrency without duplicate effects | Order API/database and event E2E suites | API/integration | Covered |
| REQ-INV-001 | Lookup, reserve, reject, release, prevent overselling | `tests/api/inventory`, `tests/database/inventory` | API/database | Covered |
| REQ-PAY-001 | Approve/decline and persist Payment idempotently | `tests/api/payment`, `tests/database/payment` | API/database | Covered |
| REQ-COMP-001 | Release Inventory after decline; record failed compensation | Order API/event resilience | Integration/resilience | Covered |
| REQ-EVT-001 | One versioned terminal event in a transactional Outbox | Contract tests and `order-notification.e2e.spec.ts` | Contract/event | Covered |
| REQ-NOT-001 | Persist one Notification per event | Event E2E and consumer duplicate test | Event/database | Covered |
| REQ-DLQ-001 | Invalid messages do not loop or block valid consumption | `notification-consumer.spec.ts` | Event/resilience | Covered |
| REQ-CORR-001 | Preserve correlation ID across request/event/Notification | Event E2E suite | Integration | Covered |
| REQ-RES-001 | Recover from database and dependency outages | `tests/resilience` | Resilience | Covered |
| REQ-RES-002 | Recover from broker/consumer outage without client replay | `messaging-resilience.spec.ts` | Event resilience | Covered |
| REQ-SEC-001 | Avoid sensitive public/event/Notification fields | API and consumer security assertions | Security contract | Covered |
| REQ-PERF-001 | Approved Order smoke with functional checks | `performance/scripts/smoke.js` | Performance | Covered/passed locally |
| REQ-PERF-002 | Moderate load meets laboratory thresholds | `performance/scripts/order-load.js` | Performance | Covered/passed locally |
| REQ-PERF-003 | Concurrent replay remains idempotent | `performance/scripts/order-concurrency.js` | Performance | Covered/passed locally |
| REQ-CI-001 | Automate quality, normal, events, and smoke | `.github/workflows/ci.yml` | CI configuration | Covered; final PR workflow passed |
| REQ-CI-002 | Provide manual resilience and full performance runs | Resilience/performance workflows | CI configuration | Configured; underlying suites passed locally |
