import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect as connectRabbitMq } from 'amqplib';
import { config } from 'dotenv';
import pg from 'pg';

import { performanceProducts } from '../data/products.js';

const { Client } = pg;
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

const urls = {
  inventory:
    process.env.INVENTORY_DATABASE_URL ??
    'postgresql://qa_user:qa_password@127.0.0.1:5433/inventory_db',
  notification:
    process.env.NOTIFICATION_DATABASE_URL ??
    'postgresql://qa_user:qa_password@127.0.0.1:5433/notifications_db',
  order:
    process.env.ORDER_DATABASE_URL ??
    'postgresql://qa_user:qa_password@127.0.0.1:5433/orders_db',
  payment:
    process.env.PAYMENT_DATABASE_URL ??
    'postgresql://qa_user:qa_password@127.0.0.1:5433/payments_db',
};

async function withClient(connectionString, operation) {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function migration(...segments) {
  return readFile(path.join(repositoryRoot, ...segments), 'utf8');
}

async function ensureNotificationDatabase() {
  const target = new URL(urls.notification);
  const databaseName = target.pathname.slice(1);
  const admin = new URL(target);
  admin.pathname = '/platform_admin';

  await withClient(admin.toString(), async (client) => {
    const result = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [databaseName],
    );
    if (result.rowCount === 0) {
      if (databaseName !== 'notifications_db') {
        throw new Error('Unexpected Notification database name.');
      }
      await client.query('CREATE DATABASE notifications_db');
    }
  });
}

async function applyMigrations() {
  await ensureNotificationDatabase();
  const inventoryMigrations = await Promise.all([
    migration('services', 'inventory-service', 'database', 'migrations', '001_create_products.sql'),
    migration('services', 'inventory-service', 'database', 'migrations', '002_create_inventory_reservations.sql'),
    migration('services', 'inventory-service', 'database', 'migrations', '003_add_reservation_release.sql'),
  ]);
  const paymentMigration = await migration(
    'services', 'payment-service', 'database', 'migrations', '001_create_payments.sql',
  );
  const orderMigrations = await Promise.all([
    migration('services', 'order-service', 'database', 'migrations', '001_create_orders.sql'),
    migration('services', 'order-service', 'database', 'migrations', '002_create_order_outbox_events.sql'),
  ]);
  const notificationMigration = await migration(
    'services', 'notification-service', 'database', 'migrations', '001_create_notifications.sql',
  );

  await withClient(urls.inventory, async (client) => {
    for (const sql of inventoryMigrations) await client.query(sql);
  });
  await withClient(urls.payment, (client) => client.query(paymentMigration));
  await withClient(urls.order, async (client) => {
    for (const sql of orderMigrations) await client.query(sql);
  });
  await withClient(urls.notification, (client) =>
    client.query(notificationMigration),
  );
}

async function performanceOrderIds() {
  return withClient(urls.order, async (client) => {
    const result = await client.query(
      `SELECT order_id AS "orderId" FROM orders WHERE sku LIKE 'PERF-%'`,
    );
    return result.rows.map((row) => row.orderId);
  });
}

async function purgePerformanceQueues() {
  const rabbitMqUrl =
    process.env.RABBITMQ_URL ??
    'amqp://qa_user:qa_password@127.0.0.1:5672/qa';
  const connection = await connectRabbitMq(rabbitMqUrl);
  const channel = await connection.createChannel();
  try {
    await channel.assertExchange('order.events', 'topic', { durable: true });
    await channel.assertExchange('order.events.dlx', 'topic', { durable: true });
    await channel.assertQueue('notification.order-events.dlq', { durable: true });
    await channel.bindQueue(
      'notification.order-events.dlq',
      'order.events.dlx',
      'notification.order-events.dlq',
    );
    await channel.assertQueue('notification.order-events', {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': 'order.events.dlx',
        'x-dead-letter-routing-key': 'notification.order-events.dlq',
      },
    });
    for (const key of [
      'order.confirmed',
      'order.inventory_rejected',
      'order.payment_declined',
      'order.compensation_failed',
    ]) {
      await channel.bindQueue('notification.order-events', 'order.events', key);
    }
    await channel.purgeQueue('notification.order-events');
    await channel.purgeQueue('notification.order-events.dlq');
  } finally {
    await channel.close().catch(() => undefined);
    await connection.close().catch(() => undefined);
  }
}

export async function cleanupPerformanceData() {
  const orderIds = await performanceOrderIds();
  if (orderIds.length > 0) {
    await withClient(urls.notification, (client) =>
      client.query('DELETE FROM notifications WHERE order_id = ANY($1::uuid[])', [orderIds]),
    );
    await withClient(urls.payment, (client) =>
      client.query('DELETE FROM payments WHERE order_id = ANY($1::uuid[])', [orderIds]),
    );
    await withClient(urls.inventory, (client) =>
      client.query(
        'DELETE FROM inventory_reservations WHERE order_id = ANY($1::uuid[])',
        [orderIds],
      ),
    );
    await withClient(urls.order, (client) =>
      client.query("DELETE FROM orders WHERE sku LIKE 'PERF-%'"),
    );
  }
  await withClient(urls.inventory, (client) =>
    client.query("DELETE FROM products WHERE sku LIKE 'PERF-%'"),
  );
  await purgePerformanceQueues();
}

export async function preparePerformanceData() {
  await applyMigrations();
  await cleanupPerformanceData();
  await withClient(urls.inventory, (client) =>
    client.query(
      `INSERT INTO products (sku, name, total_quantity, reserved_quantity)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::integer[], $4::integer[])
       ON CONFLICT (sku) DO UPDATE SET
         name = EXCLUDED.name,
         total_quantity = EXCLUDED.total_quantity,
         reserved_quantity = 0,
         updated_at = CURRENT_TIMESTAMP`,
      [
        performanceProducts.map(({ sku }) => sku),
        performanceProducts.map(({ name }) => name),
        performanceProducts.map(({ totalQuantity }) => totalQuantity),
        performanceProducts.map(() => 0),
      ],
    ),
  );
}

export async function readPerformanceConsistency() {
  const orderIds = await performanceOrderIds();
  const [orders, outbox, payments, reservations, notifications] = await Promise.all([
    withClient(urls.order, async (client) => {
      const result = await client.query(
        "SELECT count(*)::integer AS count FROM orders WHERE sku LIKE 'PERF-%' AND status = 'CONFIRMED'",
      );
      return result.rows[0].count;
    }),
    withClient(urls.order, async (client) => {
      const result = await client.query(
        `SELECT count(*)::integer AS count FROM order_outbox_events
         WHERE aggregate_id = ANY($1::uuid[]) AND published_at IS NOT NULL`,
        [orderIds],
      );
      return result.rows[0].count;
    }),
    withClient(urls.payment, async (client) => {
      const result = await client.query(
        "SELECT count(*)::integer AS count FROM payments WHERE order_id = ANY($1::uuid[]) AND status = 'APPROVED'",
        [orderIds],
      );
      return result.rows[0].count;
    }),
    withClient(urls.inventory, async (client) => {
      const result = await client.query(
        "SELECT count(*)::integer AS count FROM inventory_reservations WHERE order_id = ANY($1::uuid[]) AND status = 'RESERVED'",
        [orderIds],
      );
      return result.rows[0].count;
    }),
    withClient(urls.notification, async (client) => {
      const result = await client.query(
        'SELECT count(*)::integer AS count FROM notifications WHERE order_id = ANY($1::uuid[])',
        [orderIds],
      );
      return result.rows[0].count;
    }),
  ]);
  return { orders, payments, reservations, outbox, notifications };
}

export async function verifyPerformanceConsistency(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let counts;
  do {
    counts = await readPerformanceConsistency();
    if (
      counts.orders > 0 &&
      counts.orders === counts.payments &&
      counts.orders === counts.reservations &&
      counts.orders === counts.outbox &&
      counts.orders === counts.notifications
    ) {
      return counts;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error(`Performance consistency check failed: ${JSON.stringify(counts)}`);
}

async function main() {
  const operation = process.argv[2];
  if (operation === 'prepare') await preparePerformanceData();
  else if (operation === 'cleanup') await cleanupPerformanceData();
  else if (operation === 'verify') {
    console.log(JSON.stringify(await verifyPerformanceConsistency()));
  } else {
    throw new Error('Expected prepare, verify, or cleanup.');
  }
  if (operation !== 'verify') console.log(`Performance ${operation} completed.`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
