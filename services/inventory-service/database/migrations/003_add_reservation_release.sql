ALTER TABLE inventory_reservations
    ADD COLUMN IF NOT EXISTS release_idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS release_request_fingerprint CHAR(64),
    ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;

ALTER TABLE inventory_reservations
    DROP CONSTRAINT IF EXISTS inventory_reservations_status_valid;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'inventory_reservations_status_valid'
          AND conrelid = 'inventory_reservations'::regclass
    ) THEN
        ALTER TABLE inventory_reservations
            ADD CONSTRAINT inventory_reservations_status_valid
            CHECK (status IN ('RESERVED', 'RELEASED'));
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'inventory_reservations_release_key_not_blank'
          AND conrelid = 'inventory_reservations'::regclass
    ) THEN
        ALTER TABLE inventory_reservations
            ADD CONSTRAINT inventory_reservations_release_key_not_blank
            CHECK (
                release_idempotency_key IS NULL
                OR BTRIM(release_idempotency_key) <> ''
            );
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'inventory_reservations_release_fingerprint_valid'
          AND conrelid = 'inventory_reservations'::regclass
    ) THEN
        ALTER TABLE inventory_reservations
            ADD CONSTRAINT inventory_reservations_release_fingerprint_valid
            CHECK (
                release_request_fingerprint IS NULL
                OR release_request_fingerprint ~ '^[0-9a-f]{64}$'
            );
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'inventory_reservations_release_state_consistent'
          AND conrelid = 'inventory_reservations'::regclass
    ) THEN
        ALTER TABLE inventory_reservations
            ADD CONSTRAINT inventory_reservations_release_state_consistent
            CHECK (
                (
                    status = 'RESERVED'
                    AND release_idempotency_key IS NULL
                    AND release_request_fingerprint IS NULL
                    AND released_at IS NULL
                )
                OR
                (
                    status = 'RELEASED'
                    AND release_idempotency_key IS NOT NULL
                    AND release_request_fingerprint IS NOT NULL
                    AND released_at IS NOT NULL
                )
            );
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS inventory_reservations_release_key_unique
    ON inventory_reservations (release_idempotency_key)
    WHERE release_idempotency_key IS NOT NULL;
