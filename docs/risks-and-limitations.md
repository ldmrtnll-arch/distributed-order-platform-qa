# Risks and Limitations

| Risk or limitation | Impact | Current mitigation | Remaining limitation |
| --- | --- | --- | --- |
| At-least-once delivery can duplicate events | Duplicate notification work | `event_id UNIQUE`, duplicate ACK, replay/concurrency tests | Other future consumers must implement their own idempotency boundary |
| No exactly-once guarantee | Broker confirm/DB timing can cause redelivery | Transactional Outbox plus idempotent consumer | Duplicate delivery remains an expected broker semantic |
| No exponential backoff or delayed queue | Repeated transient failure may reconnect at a fixed interval | Bounded reconnect and no aggressive in-process hot loop | Prolonged outages are not governed by a delayed retry policy |
| `COMPENSATION_FAILED` is terminal | Reserved stock may require operator action | Explicit status/event/notification and resilience coverage | Recovery still requires an external operational process |
| No real payment provider | Gateway-specific fraud, latency, and protocol risks absent | Deterministic simulator and clear scope boundary | Provider-specific integration is untested |
| No real e-mail or SMS | External delivery behavior is not validated | Stable persisted Notification represents consumer outcome | Delivery-provider behavior is outside scope |
| Local performance is not production capacity | Results cannot predict real users/SLOs | Hardware/profile/thresholds documented without capacity claims | No production-like capacity or soak evidence |
| Four databases share one PostgreSQL container | One container outage affects every logical database | Separate ownership/schema tests; limitation explicitly documented | Infrastructure failure is still shared locally |
| Single RabbitMQ node | No broker clustering/failover evidence | Durable queues, Outbox recovery, controlled outage test | Broker-node failover is untested |
| No complete distributed tracing | Diagnosis depends on structured logs/database evidence | Correlation ID propagated and asserted end to end | No trace visualization or span-level timing |
| No global event ordering | Consumers cannot assume order across aggregates | One terminal event per Order; publisher batch order documented | Cross-aggregate ordering remains undefined |
| Infrastructure-exclusive tests | Parallel workflows could interfere | Separate jobs/workflows, serial execution, concurrency cancellation | They cannot safely share the same local infrastructure concurrently |
| Fixed laboratory credentials | Unsuitable for deployment | Used only for local/ephemeral test containers; no personal secret | Credentials must be replaced outside the laboratory |
| No soak/stress breakpoint test | Long-running leaks and capacity ceiling unknown | Short controlled load emphasizes method and repeatability | Long-duration stability and saturation remain unknown |
| Local Node 24 Playwright artifact-mode hang | Local multiple-reporter execution may not exit | CI pins Node 22/Linux and the final pull-request workflow passed | Local Node 24 reporter compatibility remains unproven |

The project intentionally excludes Kubernetes, Terraform, Kafka, Prometheus/Grafana observability, OpenTelemetry, cloud deployment, frontend, and full authentication.
