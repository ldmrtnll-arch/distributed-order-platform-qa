import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

import { ensureNotificationDatabase } from './ensure-notification-database.js';
import { orderInventoryFixtures } from './order-inventory-fixtures.js';
import {
  purgeOrderEventQueues,
  setupOrderEventTopology,
} from './rabbitmq.js';

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

function requireConnectionString(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required for event tests.`);
  }
  return value;
}

async function migration(...segments: string[]): Promise<string> {
  return readFile(path.join(repositoryRoot, ...segments), 'utf8');
}

export default async function eventsGlobalSetup(): Promise<void> {
  const orderUrl = requireConnectionString('ORDER_DATABASE_URL');
  const inventoryUrl = requireConnectionString('INVENTORY_DATABASE_URL');
  const paymentUrl = requireConnectionString('PAYMENT_DATABASE_URL');
  const notificationUrl = requireConnectionString('NOTIFICATION_DATABASE_URL');
  await ensureNotificationDatabase(notificationUrl);

  const [ordersMigration, outboxMigration, paymentMigration, notificationMigration] =
    await Promise.all([
      migration(
        'services',
        'order-service',
        'database',
        'migrations',
        '001_create_orders.sql',
      ),
      migration(
        'services',
        'order-service',
        'database',
        'migrations',
        '002_create_order_outbox_events.sql',
      ),
      migration(
        'services',
        'payment-service',
        'database',
        'migrations',
        '001_create_payments.sql',
      ),
      migration(
        'services',
        'notification-service',
        'database',
        'migrations',
        '001_create_notifications.sql',
      ),
    ]);
  const inventoryMigrations = await Promise.all(
    [
      '001_create_products.sql',
      '002_create_inventory_reservations.sql',
      '003_add_reservation_release.sql',
    ].map((file) =>
      migration(
        'services',
        'inventory-service',
        'database',
        'migrations',
        file,
      ),
    ),
  );

  const orderClient = new Client({ connectionString: orderUrl });
  try {
    await orderClient.connect();
    await orderClient.query(ordersMigration);
    await orderClient.query(outboxMigration);
    await orderClient.query('DELETE FROM orders');
  } finally {
    await orderClient.end();
  }

  const paymentClient = new Client({ connectionString: paymentUrl });
  try {
    await paymentClient.connect();
    await paymentClient.query(paymentMigration);
    await paymentClient.query('DELETE FROM payments');
  } finally {
    await paymentClient.end();
  }

  const notificationClient = new Client({ connectionString: notificationUrl });
  try {
    await notificationClient.connect();
    await notificationClient.query(notificationMigration);
    await notificationClient.query('DELETE FROM notifications');
  } finally {
    await notificationClient.end();
  }

  const eventFixtures = [
    orderInventoryFixtures.eventConfirmed,
    orderInventoryFixtures.eventPaymentDeclined,
    orderInventoryFixtures.eventConcurrent,
    orderInventoryFixtures.eventBrokerOutage,
    orderInventoryFixtures.eventNotificationDown,
    orderInventoryFixtures.eventCompensationFailed,
  ];
  const eventSkus = [
    ...eventFixtures.map((fixture) => fixture.sku),
    orderInventoryFixtures.eventInventoryRejected.sku,
  ];
  const inventoryClient = new Client({ connectionString: inventoryUrl });
  try {
    await inventoryClient.connect();
    for (const sql of inventoryMigrations) await inventoryClient.query(sql);
    await inventoryClient.query('BEGIN');
    await inventoryClient.query(
      'DELETE FROM inventory_reservations WHERE sku = ANY($1::text[])',
      [eventSkus],
    );
    await inventoryClient.query(
      `DELETE FROM products
       WHERE sku = $1`,
      [orderInventoryFixtures.eventInventoryRejected.sku],
    );
    await inventoryClient.query(
      `INSERT INTO products (sku, name, total_quantity, reserved_quantity)
       SELECT *
       FROM UNNEST($1::text[], $2::text[], $3::integer[], $4::integer[])
       ON CONFLICT (sku) DO UPDATE SET
         name = EXCLUDED.name,
         total_quantity = EXCLUDED.total_quantity,
         reserved_quantity = 0,
         updated_at = CURRENT_TIMESTAMP`,
      [
        eventFixtures.map((fixture) => fixture.sku),
        eventFixtures.map((fixture) => fixture.name),
        eventFixtures.map((fixture) => fixture.totalQuantity),
        eventFixtures.map(() => 0),
      ],
    );
    await inventoryClient.query('COMMIT');
  } catch (error) {
    await inventoryClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await inventoryClient.end();
  }

  await setupOrderEventTopology();
  await purgeOrderEventQueues();
}
