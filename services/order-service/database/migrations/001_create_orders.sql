CREATE TABLE IF NOT EXISTS orders (
    order_id UUID PRIMARY KEY,
    sku TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    currency VARCHAR(3) NOT NULL,
    status TEXT NOT NULL,
    inventory_reservation_id UUID,
    payment_id UUID,
    failure_code TEXT,
    idempotency_key TEXT NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT orders_quantity_positive CHECK (quantity > 0),
    CONSTRAINT orders_amount_positive CHECK (amount > 0),
    CONSTRAINT orders_sku_not_blank CHECK (BTRIM(sku) <> ''),
    CONSTRAINT orders_currency_valid CHECK (currency IN ('BRL')),
    CONSTRAINT orders_status_valid CHECK (
        status IN (
            'PENDING',
            'INVENTORY_RESERVED',
            'CONFIRMED',
            'INVENTORY_REJECTED',
            'PAYMENT_DECLINED',
            'COMPENSATION_FAILED'
        )
    ),
    CONSTRAINT orders_idempotency_key_not_blank
        CHECK (BTRIM(idempotency_key) <> ''),
    CONSTRAINT orders_idempotency_key_unique UNIQUE (idempotency_key),
    CONSTRAINT orders_request_fingerprint_valid
        CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    CONSTRAINT orders_state_consistent CHECK (
        (
            status = 'PENDING'
            AND inventory_reservation_id IS NULL
            AND payment_id IS NULL
            AND failure_code IS NULL
        )
        OR (
            status = 'INVENTORY_RESERVED'
            AND inventory_reservation_id IS NOT NULL
            AND payment_id IS NULL
            AND failure_code IS NULL
        )
        OR (
            status = 'CONFIRMED'
            AND inventory_reservation_id IS NOT NULL
            AND payment_id IS NOT NULL
            AND failure_code IS NULL
        )
        OR (
            status = 'INVENTORY_REJECTED'
            AND inventory_reservation_id IS NULL
            AND payment_id IS NULL
            AND BTRIM(failure_code) <> ''
        )
        OR (
            status = 'PAYMENT_DECLINED'
            AND inventory_reservation_id IS NOT NULL
            AND payment_id IS NOT NULL
            AND BTRIM(failure_code) <> ''
        )
        OR (
            status = 'COMPENSATION_FAILED'
            AND inventory_reservation_id IS NOT NULL
            AND BTRIM(failure_code) <> ''
        )
    )
);

CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at);
