CREATE TABLE IF NOT EXISTS payments (
    payment_id UUID PRIMARY KEY,
    order_id UUID NOT NULL,
    amount_in_cents INTEGER NOT NULL,
    currency VARCHAR(3) NOT NULL,
    status VARCHAR(20) NOT NULL,
    decline_code VARCHAR(50),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_fingerprint CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT payments_amount_positive
        CHECK (amount_in_cents > 0),

    CONSTRAINT payments_currency_valid
        CHECK (currency IN ('BRL')),

    CONSTRAINT payments_status_valid
        CHECK (status IN ('APPROVED', 'DECLINED')),

    CONSTRAINT payments_status_decline_code_consistent
        CHECK (
            (status = 'APPROVED' AND decline_code IS NULL)
            OR
            (status = 'DECLINED' AND BTRIM(decline_code) <> '')
        ),

    CONSTRAINT payments_idempotency_key_not_blank
        CHECK (BTRIM(idempotency_key) <> ''),

    CONSTRAINT payments_fingerprint_valid
        CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')
);
