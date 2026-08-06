import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const testsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const repositoryRoot = path.resolve(testsDirectory, '..');

config({
  path: [
    path.join(repositoryRoot, '.env'),
    path.join(repositoryRoot, '.env.example'),
  ],
  quiet: true,
});

export default async function globalSetup(): Promise<void> {
  const inventoryConnectionString = process.env.INVENTORY_DATABASE_URL;
  const paymentConnectionString = process.env.PAYMENT_DATABASE_URL;

  if (
    inventoryConnectionString === undefined ||
    inventoryConnectionString.trim() === ''
  ) {
    throw new Error('INVENTORY_DATABASE_URL is required for API tests.');
  }
  if (
    paymentConnectionString === undefined ||
    paymentConnectionString.trim() === ''
  ) {
    throw new Error('PAYMENT_DATABASE_URL is required for API tests.');
  }

  const databaseDirectory = path.join(
    repositoryRoot,
    'services',
    'inventory-service',
    'database',
  );

  const [
    productsMigration,
    reservationsMigration,
    reservationReleaseMigration,
    productsSeed,
  ] =
    await Promise.all([
      readFile(
        path.join(
          databaseDirectory,
          'migrations',
          '001_create_products.sql',
        ),
        'utf8',
      ),
      readFile(
        path.join(
          databaseDirectory,
          'migrations',
          '002_create_inventory_reservations.sql',
        ),
        'utf8',
      ),
      readFile(
        path.join(
          databaseDirectory,
          'migrations',
          '003_add_reservation_release.sql',
        ),
        'utf8',
      ),
      readFile(
        path.join(
          databaseDirectory,
          'seeds',
          '001_seed_products.sql',
        ),
        'utf8',
      ),
    ]);
  const paymentMigration = await readFile(
    path.join(
      repositoryRoot,
      'services',
      'payment-service',
      'database',
      'migrations',
      '001_create_payments.sql',
    ),
    'utf8',
  );

  const inventoryClient = new Client({
    connectionString: inventoryConnectionString,
  });

  try {
    await inventoryClient.connect();

    await inventoryClient.query(productsMigration);
    await inventoryClient.query(reservationsMigration);
    await inventoryClient.query(reservationReleaseMigration);

    await inventoryClient.query('BEGIN');

    await inventoryClient.query('DELETE FROM inventory_reservations');

    await inventoryClient.query(`
      UPDATE products
      SET reserved_quantity = 0
    `);

    await inventoryClient.query(productsSeed);

    await inventoryClient.query(`
      INSERT INTO products (
        sku,
        name,
        total_quantity,
        reserved_quantity
      )
      VALUES
        (
          'RESERVATION-IDEMP-001',
          'Reservation Idempotency Test Product',
          5,
          0
        ),
        (
          'RESERVATION-CONFLICT-001',
          'Reservation Conflict Test Product',
          5,
          0
        ),
        (
          'RESERVATION-INSUFFICIENT-001',
          'Reservation Insufficient Stock Test Product',
          2,
          0
        ),
        (
          'RESERVATION-RELEASE-IDEMP-001',
          'Reservation Release Idempotency Test Product',
          5,
          0
        ),
        (
          'RESERVATION-RELEASE-ALREADY-001',
          'Reservation Already Released Test Product',
          5,
          0
        ),
        (
          'RESERVATION-RELEASE-CONFLICT-A-001',
          'Reservation Release Key Conflict First Product',
          5,
          0
        ),
        (
          'RESERVATION-RELEASE-CONFLICT-B-001',
          'Reservation Release Key Conflict Second Product',
          5,
          0
        ),
        (
          'RESERVATION-RELEASE-CONCURRENT-SAME-KEY',
          'Concurrent Reservation Release Same Key Test Product',
          10,
          0
        ),
        (
          'RESERVATION-RELEASE-CONCURRENT-DIFFERENT-KEYS',
          'Concurrent Reservation Release Different Keys Test Product',
          10,
          0
        ),
        (
          'RESERVATION-RELEASE-VALIDATION-HEADER-MISSING',
          'Reservation Release Missing Header Test Product',
          5,
          0
        ),
        (
          'RESERVATION-RELEASE-VALIDATION-HEADER-BLANK',
          'Reservation Release Blank Header Test Product',
          5,
          0
        ),
        (
          'RESERVATION-RELEASE-VALIDATION-OBJECT',
          'Reservation Release Object Body Test Product',
          5,
          0
        ),
        (
          'RESERVATION-RELEASE-VALIDATION-ARRAY',
          'Reservation Release Array Body Test Product',
          5,
          0
        ),
        (
          'RESERVATION-RELEASE-VALIDATION-MALFORMED',
          'Reservation Release Malformed JSON Test Product',
          5,
          0
        ),
        (
          'RESERVATION-RELEASE-VALIDATION-TEXT',
          'Reservation Release Text Body Test Product',
          5,
          0
        ),
        (
          'RESERVATION-RELEASE-VALIDATION-RAW',
          'Reservation Release Raw Body Test Product',
          5,
          0
        ),
        (
          'RESERVATION-VALIDATION-HEADER-MISSING',
          'Reservation Validation Header Missing Test Product',
          3,
          0
        ),
        (
          'RESERVATION-VALIDATION-HEADER-EMPTY',
          'Reservation Validation Header Empty Test Product',
          3,
          0
        ),
        (
          'RESERVATION-VALIDATION-ORDER-MISSING',
          'Reservation Validation Order Missing Test Product',
          3,
          0
        ),
        (
          'RESERVATION-VALIDATION-ORDER-INVALID',
          'Reservation Validation Order Invalid Test Product',
          3,
          0
        ),
        (
          'RESERVATION-VALIDATION-SKU-MISSING',
          'Reservation Validation SKU Missing Test Product',
          3,
          0
        ),
        (
          'RESERVATION-VALIDATION-SKU-EMPTY',
          'Reservation Validation SKU Empty Test Product',
          3,
          0
        ),
        (
          'RESERVATION-VALIDATION-QUANTITY-MISSING',
          'Reservation Validation Quantity Missing Test Product',
          3,
          0
        ),
        (
          'RESERVATION-VALIDATION-QUANTITY-ZERO',
          'Reservation Validation Quantity Zero Test Product',
          3,
          0
        ),
        (
          'RESERVATION-VALIDATION-QUANTITY-NEGATIVE',
          'Reservation Validation Quantity Negative Test Product',
          3,
          0
        ),
        (
          'RESERVATION-VALIDATION-QUANTITY-DECIMAL',
          'Reservation Validation Quantity Decimal Test Product',
          3,
          0
        ),
        (
          'RESERVATION-VALIDATION-QUANTITY-STRING',
          'Reservation Validation Quantity String Test Product',
          3,
          0
        ),
        (
          'RESERVATION-VALIDATION-QUANTITY-NULL',
          'Reservation Validation Quantity Null Test Product',
          3,
          0
        ),
        (
          'RESERVATION-VALIDATION-UNEXPECTED-FIELD',
          'Reservation Validation Unexpected Field Test Product',
          3,
          0
        ),
        (
          'RESERVATION-PAYLOAD-EMPTY',
          'Reservation Empty Payload Test Product',
          3,
          0
        ),
        (
          'RESERVATION-PAYLOAD-ARRAY',
          'Reservation Array Payload Test Product',
          3,
          0
        ),
        (
          'RESERVATION-PAYLOAD-MALFORMED',
          'Reservation Malformed Payload Test Product',
          3,
          0
        ),
        (
          'RESERVATION-CONTENT-TYPE-MISSING',
          'Reservation Missing Content Type Test Product',
          3,
          0
        ),
        (
          'RESERVATION-CONTENT-TYPE-INVALID',
          'Reservation Invalid Content Type Test Product',
          3,
          0
        ),
        (
          'RESERVATION-DB-CREATE-001',
          'Reservation Database Creation Test Product',
          5,
          0
        ),
        (
          'RESERVATION-DB-IDEMP-001',
          'Reservation Database Idempotency Test Product',
          5,
          0
        ),
        (
          'RESERVATION-DB-FAILURE-001',
          'Reservation Database Failure Test Product',
          2,
          0
        ),
        (
          'RESERVATION-RESILIENCE-001',
          'Reservation Database Resilience Test Product',
          5,
          0
        )
      ON CONFLICT (sku)
      DO UPDATE SET
        name = EXCLUDED.name,
        total_quantity = EXCLUDED.total_quantity,
        reserved_quantity = 0
    `);

    await inventoryClient.query(`
      INSERT INTO products (
        sku,
        name,
        total_quantity,
        reserved_quantity
      )
      SELECT
        product.sku || CASE
          WHEN repetition.index = 0 THEN ''
          ELSE '-REPEAT-' || repetition.index
        END,
        product.name || CASE
          WHEN repetition.index = 0 THEN ''
          ELSE ' Repeat ' || repetition.index
        END,
        product.total_quantity,
        0
      FROM (
        VALUES
          (
            'RESERVATION-CONCURRENCY-STOCK-001',
            'Reservation Stock Concurrency Test Product',
            2
          ),
          (
            'RESERVATION-CONCURRENCY-IDEMP-001',
            'Reservation Idempotency Concurrency Test Product',
            5
          )
      ) AS product(sku, name, total_quantity)
      CROSS JOIN generate_series(0, 9) AS repetition(index)
      ON CONFLICT (sku)
      DO UPDATE SET
        name = EXCLUDED.name,
        total_quantity = EXCLUDED.total_quantity,
        reserved_quantity = 0
    `);

    await inventoryClient.query('COMMIT');
  } catch (error) {
    await inventoryClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await inventoryClient.end();
  }

  const paymentClient = new Client({
    connectionString: paymentConnectionString,
  });

  try {
    await paymentClient.connect();
    await paymentClient.query(paymentMigration);
    await paymentClient.query('DELETE FROM payments');
  } finally {
    await paymentClient.end();
  }
}
