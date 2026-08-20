import { randomUUID } from 'node:crypto';

import { expect, test, type APIRequestContext } from '@playwright/test';

import {
  cleanupOrderInventoryFixture,
  readInventoryProduct,
  readInventoryReservationsByOrderId,
  readOrderByIdempotencyKey,
} from '../support/order-inventory-database.js';
import { orderInventoryFixtures } from '../support/order-inventory-fixtures.js';
import { readPaymentsByOrderId } from '../support/order-payment-database.js';
import { readOrderOutboxByOrderId } from '../support/order-outbox-database.js';
import { readNotificationsByOrderId } from '../support/notification-database.js';
import {
  getRabbitMqStatus,
  startRabbitMq,
  stopRabbitMq,
} from '../support/docker-compose.js';
import {
  startInventoryMockServer,
  type InventoryMockServer,
} from '../support/inventory-mock-server.js';
import {
  isPortReachable,
  startInventoryService,
  type InventoryServiceProcess,
} from '../support/inventory-service-process.js';
import {
  startNotificationService,
  type NotificationServiceProcess,
} from '../support/notification-service-process.js';
import {
  isOrderPortReachable,
  startOrderService,
  type OrderServiceProcess,
} from '../support/order-service-process.js';
import {
  startPaymentService,
  type PaymentServiceProcess,
} from '../support/payment-service-process.js';
import {
  getQueueMessageCount,
  notificationQueue,
  purgeOrderEventQueues,
} from '../support/rabbitmq.js';

const inventoryUrl = 'http://127.0.0.1:3002';
const paymentUrl = 'http://127.0.0.1:3003';
const notificationUrl = 'http://127.0.0.1:3004';
const inventoryProxyUrl = 'http://127.0.0.1:3005';

async function waitForHealth(url: string, expected: unknown): Promise<void> {
  await expect
    .poll(async () => {
      try {
        const response = await fetch(`${url}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        return response.status === 200 ? response.json() : null;
      } catch {
        return null;
      }
    })
    .toEqual(expected);
}

async function waitForInventoryAndPayment(): Promise<void> {
  await waitForHealth(inventoryUrl, {
    service: 'inventory-service',
    status: 'UP',
    dependencies: { database: 'UP' },
  });
  await waitForHealth(paymentUrl, {
    service: 'payment-service',
    status: 'UP',
    dependencies: { database: 'UP' },
  });
}

async function waitForNotification(): Promise<void> {
  await waitForHealth(notificationUrl, {
    service: 'notification-service',
    status: 'UP',
    dependencies: { database: 'UP', rabbitmq: 'UP' },
  });
}

async function postOrder(
  request: APIRequestContext,
  idempotencyKey: string,
  correlationId: string,
  sku: string,
  paymentToken = 'tok_approved',
) {
  return request.post('/orders', {
    headers: {
      'Idempotency-Key': idempotencyKey,
      'X-Correlation-Id': correlationId,
    },
    data: {
      sku,
      quantity: 2,
      amountInCents: 5990,
      currency: 'BRL',
      paymentToken,
    },
    timeout: 10_000,
  });
}

async function cleanup(
  idempotencyKey: string,
  fixture: { sku: string; totalQuantity: number },
): Promise<void> {
  await cleanupOrderInventoryFixture({
    idempotencyKey,
    sku: fixture.sku,
    totalQuantity: fixture.totalQuantity,
  });
}

async function stopProcesses({
  order,
  notification,
  payment,
  inventory,
  inventoryMock,
}: {
  order: OrderServiceProcess | undefined;
  notification: NotificationServiceProcess | undefined;
  payment: PaymentServiceProcess | undefined;
  inventory: InventoryServiceProcess | undefined;
  inventoryMock?: InventoryMockServer | undefined;
}): Promise<void> {
  await order?.stop();
  await notification?.stop();
  await inventoryMock?.stop();
  await payment?.stop();
  await inventory?.stop();
}

test.describe.configure({ mode: 'serial' });

test('queues a published event while Notification is offline and consumes it after startup', async ({
  request,
}) => {
  const fixture = orderInventoryFixtures.eventNotificationDown;
  const idempotencyKey = `order-event-notification-down-${randomUUID()}`;
  const correlationId = `correlation-${randomUUID()}`;
  let inventory: InventoryServiceProcess | undefined;
  let payment: PaymentServiceProcess | undefined;
  let order: OrderServiceProcess | undefined;
  let notification: NotificationServiceProcess | undefined;

  await cleanup(idempotencyKey, fixture);
  await purgeOrderEventQueues();
  try {
    inventory = startInventoryService();
    payment = startPaymentService();
    order = startOrderService({ orderEventPublishIntervalMs: 100 });
    await waitForInventoryAndPayment();
    await waitForHealth('http://127.0.0.1:3001', {
      service: 'order-service',
      status: 'UP',
      dependencies: { database: 'UP' },
    });
    expect(await isPortReachable(3004)).toBe(false);

    const response = await postOrder(
      request,
      idempotencyKey,
      correlationId,
      fixture.sku,
    );
    expect(response.status()).toBe(201);
    const body = (await response.json()) as { orderId: string; status: string };
    expect(body.status).toBe('CONFIRMED');
    await expect
      .poll(async () => {
        const row = (await readOrderOutboxByOrderId(body.orderId))[0];
        return row?.publishedAt instanceof Date;
      })
      .toBe(true);
    await expect.poll(() => getQueueMessageCount(notificationQueue)).toBe(1);
    expect(await readNotificationsByOrderId(body.orderId)).toHaveLength(0);

    notification = startNotificationService();
    await waitForNotification();
    await expect
      .poll(async () => (await readNotificationsByOrderId(body.orderId)).length)
      .toBe(1);
    await expect.poll(() => getQueueMessageCount(notificationQueue)).toBe(0);
    expect((await readNotificationsByOrderId(body.orderId))[0]).toMatchObject({
      eventType: 'ORDER_CONFIRMED',
      correlationId,
    });
  } finally {
    await stopProcesses({ order, notification, payment, inventory });
    await cleanup(idempotencyKey, fixture);
    await purgeOrderEventQueues();
  }
});

test('keeps a pending Outbox event while RabbitMQ is offline and publishes after recovery', async ({
  request,
}) => {
  const fixture = orderInventoryFixtures.eventBrokerOutage;
  const idempotencyKey = `order-event-broker-outage-${randomUUID()}`;
  const correlationId = `correlation-${randomUUID()}`;
  let inventory: InventoryServiceProcess | undefined;
  let payment: PaymentServiceProcess | undefined;
  let order: OrderServiceProcess | undefined;
  let notification: NotificationServiceProcess | undefined;
  let orderId: string | undefined;

  await cleanup(idempotencyKey, fixture);
  await purgeOrderEventQueues();
  await stopRabbitMq();
  await expect
    .poll(async () => (await getRabbitMqStatus()).State.toLowerCase())
    .toMatch(/exited|stopped/u);

  try {
    inventory = startInventoryService();
    payment = startPaymentService();
    order = startOrderService({ orderEventPublishIntervalMs: 100 });
    await waitForInventoryAndPayment();
    await waitForHealth('http://127.0.0.1:3001', {
      service: 'order-service',
      status: 'UP',
      dependencies: { database: 'UP' },
    });

    const response = await postOrder(
      request,
      idempotencyKey,
      correlationId,
      fixture.sku,
    );
    expect(response.status()).toBe(201);
    const body = (await response.json()) as { orderId: string; status: string };
    orderId = body.orderId;
    expect(body.status).toBe('CONFIRMED');
    const orderRows = await readOrderByIdempotencyKey(idempotencyKey);
    expect(orderRows[0]?.status).toBe('CONFIRMED');
    await expect
      .poll(async () => (await readOrderOutboxByOrderId(body.orderId))[0]?.publishAttempts)
      .toBeGreaterThanOrEqual(1);
    const pendingOutbox = await readOrderOutboxByOrderId(body.orderId);
    expect(pendingOutbox).toHaveLength(1);
    expect(pendingOutbox[0]).toMatchObject({
      eventType: 'ORDER_CONFIRMED',
      correlationId,
      publishedAt: null,
      lastError: 'BROKER_UNAVAILABLE',
    });
    expect(await readNotificationsByOrderId(body.orderId)).toHaveLength(0);
    expect(order.isRunning()).toBe(true);

    await startRabbitMq();
    await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe(
      'healthy',
    );
    notification = startNotificationService();
    await waitForNotification();
    await expect
      .poll(async () => {
        const row = (await readOrderOutboxByOrderId(body.orderId))[0];
        return row?.publishedAt instanceof Date;
      })
      .toBe(true);
    await expect
      .poll(async () => (await readNotificationsByOrderId(body.orderId)).length)
      .toBe(1);
    expect((await readNotificationsByOrderId(body.orderId))[0]).toMatchObject({
      eventType: 'ORDER_CONFIRMED',
      correlationId,
    });
  } finally {
    await startRabbitMq();
    await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe(
      'healthy',
    );
    await stopProcesses({ order, notification, payment, inventory });
    await cleanup(idempotencyKey, fixture);
    await purgeOrderEventQueues();
    if (orderId !== undefined) {
      expect(await readOrderOutboxByOrderId(orderId)).toHaveLength(0);
    }
  }
});

test('publishes ORDER_COMPENSATION_FAILED after a release failure', async ({
  request,
}) => {
  const fixture = orderInventoryFixtures.eventCompensationFailed;
  const idempotencyKey = `order-event-compensation-${randomUUID()}`;
  const correlationId = `correlation-${randomUUID()}`;
  let inventory: InventoryServiceProcess | undefined;
  let payment: PaymentServiceProcess | undefined;
  let order: OrderServiceProcess | undefined;
  let notification: NotificationServiceProcess | undefined;
  let inventoryMock: InventoryMockServer | undefined;

  await cleanup(idempotencyKey, fixture);
  await purgeOrderEventQueues();
  try {
    inventory = startInventoryService();
    payment = startPaymentService();
    notification = startNotificationService();
    await waitForInventoryAndPayment();
    await waitForNotification();
    inventoryMock = await startInventoryMockServer({
      port: 3005,
      response: async (observed) => {
        if (observed.url === '/reservations') {
          const forwarded = await fetch(`${inventoryUrl}/reservations`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': String(observed.headers['idempotency-key']),
              'X-Correlation-Id': String(
                observed.headers['x-correlation-id'],
              ),
            },
            body: observed.body,
            signal: AbortSignal.timeout(2000),
          });
          return {
            status: forwarded.status,
            body: (await forwarded.json()) as unknown,
          };
        }
        return {
          status: 503,
          body: {
            code: 'INVENTORY_DATABASE_UNAVAILABLE',
            message: 'Inventory data is temporarily unavailable.',
          },
        };
      },
    });
    order = startOrderService({
      inventoryServiceUrl: inventoryProxyUrl,
      orderEventPublishIntervalMs: 100,
    });
    await expect.poll(() => isOrderPortReachable()).toBe(true);

    const response = await postOrder(
      request,
      idempotencyKey,
      correlationId,
      fixture.sku,
      'tok_declined',
    );
    expect(response.status()).toBe(503);
    expect(await response.json()).toEqual({
      code: 'ORDER_COMPENSATION_FAILED',
      message:
        'The payment was declined and the inventory reservation could not be released.',
    });
    const orderRow = (await readOrderByIdempotencyKey(idempotencyKey))[0];
    expect(orderRow).toMatchObject({
      status: 'COMPENSATION_FAILED',
      failureCode: 'INVENTORY_COMPENSATION_FAILED',
    });
    expect(orderRow).toBeDefined();
    const payments = await readPaymentsByOrderId(orderRow!.orderId);
    expect(payments[0]).toMatchObject({
      status: 'DECLINED',
      declineCode: 'CARD_DECLINED',
    });
    expect((await readInventoryReservationsByOrderId(orderRow!.orderId))[0])
      .toMatchObject({ status: 'RESERVED' });
    expect((await readInventoryProduct(fixture.sku))?.reservedQuantity).toBe(2);

    await expect
      .poll(async () => (await readNotificationsByOrderId(orderRow!.orderId)).length)
      .toBe(1);
    const outbox = await readOrderOutboxByOrderId(orderRow!.orderId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      eventType: 'ORDER_COMPENSATION_FAILED',
      correlationId,
    });
    expect(outbox[0]?.publishedAt).toBeInstanceOf(Date);
    expect((await readNotificationsByOrderId(orderRow!.orderId))[0])
      .toMatchObject({
        eventId: outbox[0]?.eventId,
        eventType: 'ORDER_COMPENSATION_FAILED',
        orderStatus: 'COMPENSATION_FAILED',
        failureCode: 'INVENTORY_COMPENSATION_FAILED',
        correlationId,
        message:
          'Order requires manual reconciliation after compensation failure.',
      });
  } finally {
    await stopProcesses({
      order,
      notification,
      payment,
      inventory,
      inventoryMock,
    });
    await cleanup(idempotencyKey, fixture);
    await purgeOrderEventQueues();
    await expect.poll(() => isPortReachable(3005)).toBe(false);
  }
});
