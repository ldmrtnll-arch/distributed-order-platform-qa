CREATE TABLE IF NOT EXISTS products (
    sku VARCHAR(64) PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    total_quantity INTEGER NOT NULL,
    reserved_quantity INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT products_name_not_blank
        CHECK (BTRIM(name) <> ''),

    CONSTRAINT products_total_quantity_not_negative
        CHECK (total_quantity >= 0),

    CONSTRAINT products_reserved_quantity_not_negative
        CHECK (reserved_quantity >= 0),

    CONSTRAINT products_reserved_quantity_within_total
        CHECK (reserved_quantity <= total_quantity)
);