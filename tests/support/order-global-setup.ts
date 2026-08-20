import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

import { orderInventoryFixtures } from './order-inventory-fixtures.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

config({
  path: [
    path.join(repositoryRoot, '.env'),
    path.join(repositoryRoot, '.env.example'),
  ],
  quiet: true,
});

export default async function orderGlobalSetup(): Promise<void> {
  const orderConnectionString = process.env.ORDER_DATABASE_URL;
  const inventoryConnectionString = process.env.INVENTORY_DATABASE_URL;
  const paymentConnectionString = process.env.PAYMENT_DATABASE_URL;
  if (
    orderConnectionString === undefined ||
    orderConnectionString.trim() === ''
  ) {
    throw new Error('ORDER_DATABASE_URL is required for order resilience.');
  }
  if (
    paymentConnectionString === undefined ||
    paymentConnectionString.trim() === ''
  ) {
    throw new Error('PAYMENT_DATABASE_URL is required for order resilience.');
  }
  if (
    inventoryConnectionString === undefined ||
    inventoryConnectionString.trim() === ''
  ) {
    throw new Error(
      'INVENTORY_DATABASE_URL is required for order resilience.',
    );
  }

  const orderMigration = await readFile(
    path.join(
      repositoryRoot,
      'services',
      'order-service',
      'database',
      'migrations',
      '001_create_orders.sql',
    ),
    'utf8',
  );
  const inventoryDatabaseDirectory = path.join(
    repositoryRoot,
    'services',
    'inventory-service',
    'database',
  );
  const inventoryMigrations = await Promise.all(
    [
      'migrations/001_create_products.sql',
      'migrations/002_create_inventory_reservations.sql',
      'migrations/003_add_reservation_release.sql',
    ].map((relativePath) =>
      readFile(path.join(inventoryDatabaseDirectory, relativePath), 'utf8'),
    ),
  );
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
  const orderClient = new Client({ connectionString: orderConnectionString });

  try {
    await orderClient.connect();
    await orderClient.query(orderMigration);
    await orderClient.query('DELETE FROM orders');
  } finally {
    await orderClient.end();
  }

  const inventoryClient = new Client({
    connectionString: inventoryConnectionString,
  });
  const resilienceProducts = [
    orderInventoryFixtures.resilience,
    orderInventoryFixtures.resilienceTimeout,
    orderInventoryFixtures.resilienceUnexpected409,
    orderInventoryFixtures.resilienceInvalidContract,
    orderInventoryFixtures.paymentUnavailable,
    orderInventoryFixtures.paymentTimeout,
    orderInventoryFixtures.paymentInvalidContract,
    orderInventoryFixtures.paymentUnexpectedStatus,
    orderInventoryFixtures.compensationFailed,
  ];

  try {
    await inventoryClient.connect();
    for (const migration of inventoryMigrations) {
      await inventoryClient.query(migration);
    }

    await inventoryClient.query('BEGIN');
    await inventoryClient.query(
      `DELETE FROM inventory_reservations
       WHERE sku = ANY($1::text[])`,
      [resilienceProducts.map((product) => product.sku)],
    );
    await inventoryClient.query(
      `INSERT INTO products (
         sku,
         name,
         total_quantity,
         reserved_quantity
       )
       SELECT *
       FROM UNNEST(
         $1::text[],
         $2::text[],
         $3::integer[],
         $4::integer[]
       )
       ON CONFLICT (sku)
       DO UPDATE SET
         name = EXCLUDED.name,
         total_quantity = EXCLUDED.total_quantity,
         reserved_quantity = EXCLUDED.reserved_quantity,
         updated_at = CURRENT_TIMESTAMP`,
      [
        resilienceProducts.map((product) => product.sku),
        resilienceProducts.map((product) => product.name),
        resilienceProducts.map((product) => product.totalQuantity),
        resilienceProducts.map(() => 0),
      ],
    );
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
