CREATE TABLE IF NOT EXISTS notifications (
    notification_id UUID PRIMARY KEY,
    event_id UUID NOT NULL,
    order_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    event_version INTEGER NOT NULL,
    order_status TEXT NOT NULL,
    failure_code TEXT,
    correlation_id TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT notifications_event_id_unique UNIQUE (event_id),
    CONSTRAINT notifications_event_type_valid CHECK (
        event_type IN (
            'ORDER_CONFIRMED',
            'ORDER_INVENTORY_REJECTED',
            'ORDER_PAYMENT_DECLINED',
            'ORDER_COMPENSATION_FAILED'
        )
    ),
    CONSTRAINT notifications_event_version_valid CHECK (event_version = 1),
    CONSTRAINT notifications_status_valid CHECK (
        order_status IN (
            'CONFIRMED',
            'INVENTORY_REJECTED',
            'PAYMENT_DECLINED',
            'COMPENSATION_FAILED'
        )
    ),
    CONSTRAINT notifications_correlation_id_not_blank
        CHECK (BTRIM(correlation_id) <> ''),
    CONSTRAINT notifications_message_not_blank CHECK (BTRIM(message) <> '')
);

CREATE INDEX IF NOT EXISTS notifications_order_id_idx
    ON notifications (order_id);

CREATE INDEX IF NOT EXISTS notifications_created_at_idx
    ON notifications (created_at);
