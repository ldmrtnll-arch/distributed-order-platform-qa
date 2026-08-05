CREATE TABLE IF NOT EXISTS inventory_reservations (
    reservation_id UUID PRIMARY KEY,
    order_id UUID NOT NULL,
    sku VARCHAR(64) NOT NULL,
    quantity INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'RESERVED',
    idempotency_key TEXT NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT inventory_reservations_product_fk
        FOREIGN KEY (sku)
        REFERENCES products (sku)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT inventory_reservations_quantity_positive
        CHECK (quantity > 0),

    CONSTRAINT inventory_reservations_status_valid
        CHECK (status IN ('RESERVED')),

    CONSTRAINT inventory_reservations_idempotency_key_not_blank
        CHECK (BTRIM(idempotency_key) <> ''),

    CONSTRAINT inventory_reservations_idempotency_key_unique
        UNIQUE (idempotency_key),

    CONSTRAINT inventory_reservations_fingerprint_valid
        CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')
);
