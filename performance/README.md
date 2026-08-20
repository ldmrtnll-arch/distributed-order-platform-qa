# K6 Performance Tests

These scenarios exercise the real `POST /orders` workflow through Inventory, Payment, the transactional Outbox, RabbitMQ, and Notification.

K6 runs from the pinned `grafana/k6:0.54.0` Docker image, so no global installation is required. The Node runner prepares dedicated `PERF-%` products, starts the four services, waits for their health endpoints, runs K6, verifies cross-database/event consistency, stops only its child processes, and cleans all performance data and project queues in `finally`.

## Commands

```text
npm run test:performance:smoke
npm run test:performance:load
npm run test:performance:concurrency
```

Data operations can also be invoked independently:

```text
npm run performance:prepare
npm run performance:verify
npm run performance:cleanup
```

PostgreSQL and RabbitMQ must already be healthy. Ports 3001–3004 must be free. Generated K6 summaries and service logs are written under `artifacts/performance/` and are intentionally ignored by Git.

Docker K6 reaches host services through Docker Desktop's native `host.docker.internal` DNS on Windows. On Linux and GitHub-hosted runners, it uses `--network host` and `127.0.0.1`. The runner selects the mode through `process.platform`.

The load profile is intentionally short and paced: 0→5 VUs, 5→10 VUs, then ramp-down over 35 seconds with a one-second iteration pause. It is a local laboratory workload, not a production capacity claim or SLO.
