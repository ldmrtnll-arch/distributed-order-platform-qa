# Test Execution Report

## Environment and baseline

Execution date: 2026-08-20. Baseline commit: `aa734c6`, merge of Order Events + Notification Service into `main`.

| Validation | Result |
| --- | --- |
| Typecheck baseline | 5 workspaces passed |
| Build baseline | 5 workspaces passed |
| Normal baseline | 123 passed in 5.2s |
| Events baseline | 21 passed in 17.6s |
| Order resilience baseline | 10 passed in 25.2s |
| Inventory resilience baseline | 2 passed in 17.4s |
| Payment resilience baseline | 1 passed in 9.1s |

## Performance evidence

| Scenario | Result | Requests | Error rate | Checks | p95 | p99 | Consistent rows |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Smoke | Passed | 5 | 0.00% | 20/20 | 86.21 ms | 94.57 ms | 5 |
| Load | Passed | 224 | 0.00% | 896/896 | 43.58 ms | 45.55 ms | 224 |
| Concurrency | Passed | 30 | 0.00% | 60/60 | 116.77 ms | 118.02 ms | 15 |

Each consistency count matched across confirmed Orders, approved Payments, reserved Inventory reservations, published Outbox events, and Notifications. Performance data was removed after each scenario.

## Final local validation

| Validation | Result |
| --- | --- |
| `npm ci` | 118 packages installed; 0 vulnerabilities reported |
| Typecheck | 5 workspaces passed |
| Build | 5 workspaces passed |
| Normal Playwright | 123 passed in 4.5s |
| Events run 1 | 21 passed in 17.7s |
| Events run 2 | 21 passed in 17.2s |
| Order resilience | 10 passed in 24.1s |
| Inventory resilience | 2 passed in 17.6s |
| Payment resilience | 1 passed in 8.9s |

The normal and event command strings match the CI workflow. Playwright HTML generation is configured only for CI with `open: never`.

## CI test-isolation correction

The first remote CI run exposed a test-isolation issue: the API and database job finished with 110 passed and 13 Order cleanup failures because the clean runner had no `notifications` table. The normal global setup now creates `notifications_db` when needed and applies the official Notification Service migration without starting the Notification Service.

Local isolation validation after the correction:

| Order | Result |
| --- | --- |
| Fresh Notification database -> `npm test` | 123 passed in 4.9s |
| Immediate second `npm test` | 123 passed in 4.7s |
| `npm run test:events` -> `npm test` | 21 passed in 17.2s; 123 passed in 4.7s |
| `npm test` -> `npm run test:events` | 123 passed in 4.7s; 21 passed in 17.5s |
| Typecheck after correction | 5 workspaces passed |
| Build after correction | 5 workspaces passed |

The corrective pull-request workflow subsequently passed in GitHub Actions, as confirmed by the project owner. No remote run ID, duration, or timestamp is recorded because those values were not supplied.

## Final portfolio audit

| Validation | Local result |
| --- | --- |
| `npm ci` / `npm audit` | 118 packages installed; 0 vulnerabilities |
| Typecheck | 5 workspaces passed |
| Build | 5 workspaces passed |
| Normal Playwright | 123 passed in 4.8s |
| Events, including contracts | 21 passed in 17.2s |
| Order resilience | 10 passed in 25.7s |
| Inventory resilience | 2 passed in 17.7s |
| Payment resilience | 1 passed in 9.0s |
| K6 smoke | 5/5 iterations; 20/20 checks; 0.00% HTTP errors; consistency 5/5 across all stages |

GitHub Actions final pull-request run: passed. The automatic workflow covers typecheck/build, normal API/database tests, event tests, and K6 smoke. Resilience and the complete performance sequence remain manual workflows.

## Evidence handling

Local raw K6 summaries and service logs are generated under ignored `artifacts/performance/`. CI uploads K6 and Playwright reports for 10 days. This report retains only the compact, selected evidence appropriate for source control.
