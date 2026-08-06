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
  path: path.join(repositoryRoot, '.env'),
});

export default async function globalSetup(): Promise<void> {
  const connectionString = process.env.INVENTORY_DATABASE_URL;

  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('INVENTORY_DATABASE_URL is required for API tests.');
  }

  const databaseDirectory = path.join(
    repositoryRoot,
    'services',
    'inventory-service',
    'database',
  );

  const [productsMigration, reservationsMigration, productsSeed] =
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
          'seeds',
          '001_seed_products.sql',
        ),
        'utf8',
      ),
    ]);

  const client = new Client({ connectionString });

  try {
    await client.connect();

    await client.query(productsMigration);
    await client.query(reservationsMigration);

    await client.query('BEGIN');

    await client.query('DELETE FROM inventory_reservations');

    await client.query(`
      UPDATE products
      SET reserved_quantity = 0
    `);

    await client.query(productsSeed);

    await client.query(`
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
        )
      ON CONFLICT (sku)
      DO UPDATE SET
        name = EXCLUDED.name,
        total_quantity = EXCLUDED.total_quantity,
        reserved_quantity = 0
    `);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
