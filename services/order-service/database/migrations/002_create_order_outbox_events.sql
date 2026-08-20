CREATE TABLE IF NOT EXISTS order_outbox_events (
    event_id UUID PRIMARY KEY,
    aggregate_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    event_version INTEGER NOT NULL,
    payload JSONB NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    publish_attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,

    CONSTRAINT order_outbox_aggregate_fk
        FOREIGN KEY (aggregate_id) REFERENCES orders (order_id) ON DELETE CASCADE,
    CONSTRAINT order_outbox_terminal_event_unique UNIQUE (aggregate_id),
    CONSTRAINT order_outbox_event_type_valid CHECK (
        event_type IN (
            'ORDER_CONFIRMED',
            'ORDER_INVENTORY_REJECTED',
            'ORDER_PAYMENT_DECLINED',
            'ORDER_COMPENSATION_FAILED'
        )
    ),
    CONSTRAINT order_outbox_event_version_valid CHECK (event_version = 1),
    CONSTRAINT order_outbox_correlation_id_not_blank
        CHECK (BTRIM(correlation_id) <> ''),
    CONSTRAINT order_outbox_publish_attempts_valid CHECK (publish_attempts >= 0),
    CONSTRAINT order_outbox_last_error_valid CHECK (
        last_error IS NULL
        OR last_error IN ('BROKER_UNAVAILABLE', 'PUBLISH_FAILED', 'UNROUTABLE_MESSAGE')
    )
);

CREATE INDEX IF NOT EXISTS order_outbox_pending_idx
    ON order_outbox_events (published_at, created_at);

CREATE INDEX IF NOT EXISTS order_outbox_created_at_idx
    ON order_outbox_events (created_at);

CREATE INDEX IF NOT EXISTS order_outbox_aggregate_id_idx
    ON order_outbox_events (aggregate_id);
