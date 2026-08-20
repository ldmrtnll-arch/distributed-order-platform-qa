# Performance Test Report

## Objective

Evaluate the real approved `POST /orders` workflow under minimal load, moderate paced load, and concurrent idempotent replay. The tests include Inventory, Payment, terminal Outbox publication, RabbitMQ consumption, and Notification persistence.

These results describe this local laboratory run only. They are not production SLOs or a statement of supported production users.

## Environment

Executed on 2026-08-20:

* Windows 11 Pro 10.0.26200;
* Intel Core Ultra 7 265, 20 cores/logical processors;
* approximately 31.3 GiB physical memory;
* Node.js 24.19.0 and npm 11.17.0;
* Docker 29.5.3-rd and Compose 5.1.4;
* `grafana/k6:0.54.0` container;
* PostgreSQL 18.4 Alpine and RabbitMQ 4.3.4 Management Alpine;
* all four Node services running on the host; K6 running in Docker Desktop.

## Scenarios

| Scenario | Configuration | Purpose |
| --- | --- | --- |
| Smoke | 1 VU, 5 shared iterations | Validate basic function and latency |
| Load | 0→5 VUs, hold, 5→10 VUs, hold, ramp-down; 35s; 1s pacing | Moderate repeatable local workload |
| Concurrency | 5 VUs × 3 iterations, two simultaneous calls per iteration | Validate replay behavior under contention |

Every independent operation uses a unique `Idempotency-Key` and identifiable `X-Correlation-Id`. The concurrency scenario intentionally shares one key only within each two-request pair.

## Thresholds

Calibration first measured p95 between 44.49 and 112.42 ms. The final laboratory thresholds are:

* `http_req_failed < 1%`;
* `checks > 99%`;
* `order_confirmed > 99%`;
* `http_req_duration p95 < 750 ms`;
* `http_req_duration p99 < 1500 ms`;
* `idempotent_pair > 99%` for concurrency.

The latency margins account for local/CI virtualization while remaining below the application's dependency timeouts. They were selected after calibration and were not weakened in response to a performance failure.

## Final results

| Metric | Smoke | Load | Concurrency |
| --- | ---: | ---: | ---: |
| HTTP requests | 5 | 224 | 30 |
| Requests/s | 21.00 | 6.33 | 164.53 |
| Iterations | 5 | 224 | 15 pairs |
| Checks | 20/20 | 896/896 | 60/60 |
| HTTP error rate | 0.00% | 0.00% | 0.00% |
| Duration average | 46.97 ms | 30.23 ms | 56.78 ms |
| p90 | 75.76 ms | 41.53 ms | 115.87 ms |
| p95 | 86.21 ms | 43.58 ms | 116.77 ms |
| p99 | 94.57 ms | 45.55 ms | 118.02 ms |
| Maximum | 96.66 ms | 84.06 ms | 118.35 ms |
| Interrupted iterations | 0 | 0 | 0 |
| Dropped iterations | Not emitted by these executors | Not emitted by this executor | Not emitted by this executor |

The load requests/s value is intentionally constrained by one-second pacing and the staged VU profile; it is not maximum throughput.

## Consistency evidence

The runner polled after K6 until the asynchronous workflow converged:

| Scenario | Confirmed Orders | Approved Payments | Reserved reservations | Published Outbox | Notifications |
| --- | ---: | ---: | ---: | ---: | ---: |
| Smoke | 5 | 5 | 5 | 5 | 5 |
| Load | 224 | 224 | 224 | 224 | 224 |
| Concurrency | 15 | 15 | 15 | 15 | 15 |

Concurrency sent 30 HTTP requests but persisted 15 business operations, proving the observed idempotency result.

## Interpretation

All functional and latency thresholds passed. No HTTP errors, dropped business operations, duplicated database effects, pending Outbox rows, or missing Notifications were observed. Concurrent pairs were slower than the paced load, but remained far below the laboratory threshold.

No saturation point was sought, so the run cannot identify maximum capacity. The main methodological evidence is controlled data, functional checks, objective thresholds, eventual-consistency auditing, and repeatable cleanup.

## Limitations

The services and databases share one workstation and one Docker engine. PostgreSQL databases share a container and RabbitMQ has one node. Network conditions, production datasets, TLS, autoscaling, noisy neighbors, long soak behavior, failover, and cloud latency are not represented.
