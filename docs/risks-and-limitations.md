# Risks and Limitations

| Risk or limitation | Impact | Current mitigation |
| --- | --- | --- |
| At-least-once delivery can duplicate events | Duplicate notification work | `event_id UNIQUE`, duplicate ACK, replay/concurrency tests |
| No exactly-once guarantee | Broker confirm/DB timing can cause redelivery | Transactional Outbox plus idempotent consumer |
| No exponential backoff or delayed queue | Repeated transient failure may reconnect at a fixed interval | Bounded reconnect and no aggressive in-process hot loop |
| `COMPENSATION_FAILED` is terminal | Reserved stock may require operator action | Explicit status/event/notification and resilience coverage |
| No real payment provider | Gateway-specific fraud, latency, and protocol risks absent | Deterministic simulator and clear scope boundary |
| No real e-mail or SMS | External delivery behavior is not validated | Stable persisted Notification represents consumer outcome |
| Local performance is not production capacity | Results cannot predict real users/SLOs | Hardware/profile/thresholds documented without capacity claims |
| Four databases share one PostgreSQL container | One container outage affects every logical database | Separate ownership/schema tests; limitation explicitly documented |
| Single RabbitMQ node | No broker clustering/failover evidence | Durable queues, Outbox recovery, controlled outage test |
| No complete distributed tracing | Diagnosis depends on structured logs/database evidence | Correlation ID propagated and asserted end to end |
| No global event ordering | Consumers cannot assume order across aggregates | One terminal event per Order; publisher batch order documented |
| Infrastructure-exclusive tests | Parallel workflows could interfere | Separate jobs/workflows, serial execution, concurrency cancellation |
| Fixed laboratory credentials | Unsuitable for deployment | Used only for local/ephemeral test containers; no personal secret |
| No soak/stress breakpoint test | Long-running leaks and capacity ceiling unknown | Short controlled load emphasizes method and repeatability |
| Playwright artifact mode was not proven on the local Node 24 host | The first remote report upload could reveal a runner-specific issue | CI pins Node 22/Linux; command behavior and YAML were validated, remote result is explicitly pending |

The project intentionally excludes Kubernetes, Terraform, Kafka, Prometheus/Grafana observability, OpenTelemetry, cloud deployment, frontend, and full authentication.
