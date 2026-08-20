# Resolved Bug Reports

Only defects observed during implementation are recorded. Classification distinguishes product behavior from test-harness problems.

## BUG-PROD-001 — Non-JSON reservation release accepted incorrectly

* **Classification/severity:** Product bug, medium.
* **Environment:** Inventory Service API.
* **Steps:** Send a release request body without an `application/json` media type.
* **Expected:** Controlled validation error without state change.
* **Observed:** The request previously reached release handling incorrectly.
* **Cause:** Content-type/body validation did not reject this raw request before routing.
* **Correction:** Added explicit application/json enforcement and regression coverage (`977eb18`).
* **Status:** Resolved.

## BUG-TEST-001 — Parallel worker cleanup race

* **Classification/severity:** Test-harness bug, medium.
* **Environment:** Parallel Playwright execution.
* **Steps:** Run scenarios whose shared `afterAll` cleanup overlaps work in another worker.
* **Expected:** Each test retains its fixture until its assertions complete.
* **Observed:** Shared cleanup could remove/reset data still in use.
* **Cause:** Cleanup ownership was broader than the scenario lifecycle.
* **Correction:** Moved cleanup to scenario-specific keys/fixtures and controlled global baselines.
* **Status:** Resolved.

## BUG-TEST-002 — Ajv strict-mode schema incompatibility

* **Classification/severity:** Contract/test integration bug, medium.
* **Environment:** Notification JSON Schema compilation.
* **Steps:** Compile the initial conditional event schema with Ajv strict mode.
* **Expected:** The shared schema compiles and validates all four event types.
* **Observed:** Conditional branches were rejected because their object type was implicit.
* **Cause:** Strict JSON Schema typing requires explicit object context in those branches.
* **Correction:** Added explicit `type: object`; validation remained strict.
* **Status:** Resolved.

## BUG-TEST-003 — Event suites collected by the normal config

* **Classification/severity:** Test configuration bug, high.
* **Environment:** Default Playwright suite after adding `tests/events`.
* **Steps:** Run `npm test` while exclusive event suites exist below the same test root.
* **Expected:** Only normal parallel API/database tests execute.
* **Observed:** Event suites ran concurrently and contended for ports and fixtures.
* **Cause:** The default `testIgnore` excluded resilience but not events.
* **Correction:** Added `**/events/**` to the normal ignore list and retained `test:events` as a serial entry point.
* **Status:** Resolved.

## BUG-INFRA-001 — Publisher shutdown race

* **Classification/severity:** Service lifecycle bug, medium.
* **Environment:** Order Service graceful shutdown during active Outbox polling.
* **Steps:** Terminate Order while a publisher poll is active.
* **Expected:** Finish the in-flight poll, then close AMQP resources.
* **Observed:** Channel/connection could close first and produce an artificial publish failure.
* **Cause:** Shutdown resource order was reversed.
* **Correction:** Stop scheduling, wait for the active poll, then close channel and connection.
* **Status:** Resolved.

## BUG-INFRA-002 — Docker K6 host routing overridden on Windows

* **Classification/severity:** Performance harness bug, medium.
* **Environment:** Docker Desktop on Windows.
* **Steps:** Run K6 with an explicit `host-gateway` alias.
* **Expected:** Container reaches Order on host port 3001.
* **Observed:** All five calibration requests received connection refused at `172.17.0.1`.
* **Cause:** The explicit alias replaced Docker Desktop's native host DNS mapping.
* **Correction:** Use native `host.docker.internal` on Windows and host networking on Linux.
* **Status:** Resolved and followed by passing smoke/load/concurrency runs.

## BUG-INFRA-003 - Playwright artifact mode hangs locally on Node 24

* **Classification/severity:** Local tooling compatibility, low.
* **Environment:** Windows 11, Node.js 24.19.0, Playwright CI/multiple-reporter mode.
* **Steps:** Run the complete normal suite with `CI=true` and an additional HTML or blob reporter.
* **Expected:** The 123 completed tests are summarized and the process exits.
* **Observed:** All 123 tests completed, but the process remained open until its known execution session was interrupted; the same suite with the line reporter exited in 4.6 seconds.
* **Cause:** Not proven; isolated to local Node 24 CI/artifact mode rather than service behavior or functional tests.
* **Correction:** CI is pinned to Node 22/Linux and configures HTML with `open: never`; remote behavior must be confirmed by the first workflow run.
* **Status:** Open validation risk; it does not justify claiming a remote green run.

## BUG-TEST-004 - Normal Playwright suite depended on Notification schema created by the events suite

* **Classification/severity:** Test infrastructure / CI, high.
* **Environment:** GitHub Actions API and database tests on a clean PostgreSQL runner.
* **Observed:** The normal suite reported 110 passed and 13 failed; every failure ended during Order fixture cleanup with `relation "notifications" does not exist`.
* **Cause:** Order cleanup removes related Notifications, but the normal global setup did not guarantee that `notifications_db` existed or apply the Notification Service migration.
* **Why local execution passed:** Earlier event or performance runs had already created and migrated the local Notification database.
* **Correction:** The normal global setup now reuses the shared database-creation helper, applies the official Notification migration, and establishes a clean Notification baseline.
* **Prevention:** Every CI suite must initialize all schemas used by its own helpers instead of depending on state left by another suite or runner.
* **Status:** Resolved.
