import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { queryNotificationDatabase } from '../support/database.js';
import {
  cleanupNotificationsByOrderIds,
  readNotificationsByEventId,
} from '../support/notification-database.js';
import { isPortReachable } from '../support/inventory-service-process.js';
import {
  startNotificationService,
  type NotificationServiceProcess,
} from '../support/notification-service-process.js';
import {
  getQueueMessageCount,
  notificationDeadLetterQueue,
  notificationQueue,
  publishOrderEvent,
  publishRawOrderEvent,
  purgeOrderEventQueues,
} from '../support/rabbitmq.js';

let notificationProcess: NotificationServiceProcess;

function confirmedEvent(eventId = randomUUID(), orderId = randomUUID()) {
  return {
    eventId,
    eventType: 'ORDER_CONFIRMED',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    correlationId: `correlation-${randomUUID()}`,
    orderId,
    data: {
      status: 'CONFIRMED',
      sku: 'ORDER-EVENT-MANUAL-001',
      quantity: 2,
      amountInCents: 5990,
      currency: 'BRL',
      failureCode: null,
    },
  };
}

async function waitForNotificationHealth(): Promise<void> {
  await expect
    .poll(async () => {
      try {
        const response = await fetch('http://127.0.0.1:3004/health', {
          signal: AbortSignal.timeout(1000),
        });
        return response.status === 200 ? response.json() : null;
      } catch {
        return null;
      }
    })
    .toEqual({
      service: 'notification-service',
      status: 'UP',
      dependencies: { database: 'UP', rabbitmq: 'UP' },
    });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(await isPortReachable(3004)).toBe(false);
  await purgeOrderEventQueues();
  notificationProcess = startNotificationService();
  await waitForNotificationHealth();
});

test.afterAll(async () => {
  await notificationProcess?.stop();
  await purgeOrderEventQueues();
  await expect.poll(() => isPortReachable(3004)).toBe(false);
});

test('reports healthy database and RabbitMQ dependencies', async ({ request }) => {
  const response = await request.get('http://127.0.0.1:3004/health');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  expect(await response.json()).toEqual({
    service: 'notification-service',
    status: 'UP',
    dependencies: { database: 'UP', rabbitmq: 'UP' },
  });
});

test('ACKs duplicate deliveries and persists one Notification by eventId', async () => {
  const event = confirmedEvent();
  await cleanupNotificationsByOrderIds([event.orderId]);
  await purgeOrderEventQueues();

  try {
    await publishOrderEvent('order.confirmed', event, {
      messageId: event.eventId,
      correlationId: event.correlationId,
    });
    await publishOrderEvent('order.confirmed', event, {
      messageId: event.eventId,
      correlationId: event.correlationId,
    });
    await expect
      .poll(async () => (await readNotificationsByEventId(event.eventId)).length)
      .toBe(1);
    await expect.poll(() => getQueueMessageCount(notificationQueue)).toBe(0);
    const rows = await readNotificationsByEventId(event.eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventId: event.eventId,
      orderId: event.orderId,
      eventType: 'ORDER_CONFIRMED',
      eventVersion: 1,
      orderStatus: 'CONFIRMED',
      failureCode: null,
      correlationId: event.correlationId,
      message: 'Order confirmed.',
    });
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    expect(notificationProcess.logs()).toContain('Duplicate order event ignored');
  } finally {
    await cleanupNotificationsByOrderIds([event.orderId]);
    await purgeOrderEventQueues();
  }
});

test('dead-letters a poison message and continues consuming valid events', async () => {
  const validEvent = confirmedEvent();
  await cleanupNotificationsByOrderIds([validEvent.orderId]);
  await purgeOrderEventQueues();

  try {
    await publishRawOrderEvent(
      'order.confirmed',
      JSON.stringify({ eventType: 'INVALID_EVENT' }),
    );
    await expect
      .poll(() => getQueueMessageCount(notificationDeadLetterQueue))
      .toBe(1);
    expect(await getQueueMessageCount(notificationQueue)).toBe(0);
    expect(await readNotificationsByEventId(validEvent.eventId)).toHaveLength(0);

    await publishOrderEvent('order.confirmed', validEvent, {
      messageId: validEvent.eventId,
      correlationId: validEvent.correlationId,
    });
    await expect
      .poll(
        async () =>
          (await readNotificationsByEventId(validEvent.eventId)).length,
      )
      .toBe(1);
    await waitForNotificationHealth();
    expect(notificationProcess.logs()).toContain(
      'Invalid order event dead-lettered',
    );
  } finally {
    await cleanupNotificationsByOrderIds([validEvent.orderId]);
    await purgeOrderEventQueues();
  }
});

test('does not define sensitive payment or infrastructure columns', async () => {
  const columns = await queryNotificationDatabase<{ columnName: string }>(
    `SELECT column_name AS "columnName"
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'notifications'`,
  );
  const names = columns.map((column) => column.columnName);
  expect(names).not.toEqual(
    expect.arrayContaining([
      'payment_token',
      'idempotency_key',
      'request_fingerprint',
      'inventory_reservation_id',
      'payment_id',
      'database_url',
      'password',
    ]),
  );
});
