INSERT INTO products (
    sku,
    name,
    total_quantity,
    reserved_quantity
)
VALUES
    (
        'BOOK-001',
        'Distributed Systems Fundamentals',
        10,
        0
    ),
    (
        'HEADSET-001',
        'Wireless QA Headset',
        2,
        0
    ),
    (
        'KEYBOARD-001',
        'Mechanical Testing Keyboard',
        0,
        0
    )
ON CONFLICT (sku)
DO UPDATE SET
    name = EXCLUDED.name,
    total_quantity = EXCLUDED.total_quantity,
    reserved_quantity = EXCLUDED.reserved_quantity,
    updated_at = CURRENT_TIMESTAMP;