import { randomUUID } from 'node:crypto';

import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';

import {
  cleanupOrderByIdempotencyKey,
  cleanupOrderInventoryFixture,
  countInventoryReservationsBySku,
  countOrdersByIdempotencyKey,
  readInventoryProduct,
  readInventoryReservationsByOrderId,
  readOrderByIdempotencyKey,
} from '../support/order-inventory-database.js';
import { orderInventoryFixtures } from '../support/order-inventory-fixtures.js';
import {
  countPaymentsByOrderId,
  readPaymentsByOrderId,
} from '../support/order-payment-database.js';
import { readOrderOutboxByOrderId } from '../support/order-outbox-database.js';
import { readNotificationsByOrderId } from '../support/notification-database.js';
import {
  isPortReachable,
  startInventoryService,
  type InventoryServiceProcess,
} from '../support/inventory-service-process.js';
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
  startNotificationService,
  type NotificationServiceProcess,
} from '../support/notification-service-process.js';
import { purgeOrderEventQueues } from '../support/rabbitmq.js';

interface EventFixture {
  sku: string;
  totalQuantity: number;
}

interface PublicOrder {
  orderId: string;
  sku: string;
  quantity: number;
  amountInCents: number;
  currency: string;
  status: string;
  createdAt: string;
}

const serviceUrls = {
  order: 'http://127.0.0.1:3001',
  inventory: 'http://127.0.0.1:3002',
  payment: 'http://127.0.0.1:3003',
  notification: 'http://127.0.0.1:3004',
};
const publicOrderFields = [
  'amountInCents',
  'createdAt',
  'currency',
  'orderId',
  'quantity',
  'sku',
  'status',
];

let inventoryProcess: InventoryServiceProcess;
let paymentProcess: PaymentServiceProcess;
let orderProcess: OrderServiceProcess;
let notificationProcess: NotificationServiceProcess;

function orderBody(sku: string, paymentToken = 'tok_approved') {
  return {
    sku,
    quantity: 2,
    amountInCents: 5990,
    currency: 'BRL',
    paymentToken,
  };
}

async function waitForHealth(
  url: string,
  expectedBody: unknown,
): Promise<void> {
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
    .toEqual(expectedBody);
}

async function postOrder(
  request: APIRequestContext,
  idempotencyKey: string,
  correlationId: string,
  sku: string,
  paymentToken = 'tok_approved',
): Promise<APIResponse> {
  return request.post('/orders', {
    headers: {
      'Idempotency-Key': idempotencyKey,
      'X-Correlation-Id': correlationId,
    },
    data: orderBody(sku, paymentToken),
    timeout: 10_000,
  });
}

async function readPublicOrder(
  response: APIResponse,
  expectedHttpStatus: number,
  expectedOrderStatus: string,
): Promise<PublicOrder> {
  expect(response.status()).toBe(expectedHttpStatus);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  const body = (await response.json()) as PublicOrder;
  expect(Object.keys(body).sort()).toEqual(publicOrderFields);
  expect(body.status).toBe(expectedOrderStatus);
  expect(body.orderId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
  return body;
}

async function expectTerminalDelivery({
  orderId,
  eventType,
  status,
  correlationId,
  failureCode,
  message,
}: {
  orderId: string;
  eventType: string;
  status: string;
  correlationId: string;
  failureCode: string | null;
  message: string;
}) {
  await expect
    .poll(async () => {
      const rows = await readOrderOutboxByOrderId(orderId);
      return rows[0]?.publishedAt instanceof Date;
    })
    .toBe(true);
  const outboxRows = await readOrderOutboxByOrderId(orderId);
  expect(outboxRows).toHaveLength(1);
  expect(outboxRows[0]).toMatchObject({
    aggregateId: orderId,
    eventType,
    eventVersion: 1,
    correlationId,
    lastError: null,
  });
  expect(outboxRows[0]?.eventId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

  await expect
    .poll(async () => (await readNotificationsByOrderId(orderId)).length)
    .toBe(1);
  const notifications = await readNotificationsByOrderId(orderId);
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({
    eventId: outboxRows[0]?.eventId,
    orderId,
    eventType,
    eventVersion: 1,
    orderStatus: status,
    failureCode,
    correlationId,
    message,
  });

  const serializedEvent = JSON.stringify(outboxRows[0]?.payload);
  const serializedNotification = JSON.stringify(notifications[0]);
  expect(serializedEvent).not.toMatch(
    /paymentToken|tok_approved|tok_declined|idempotency|fingerprint|inventoryReservationId|paymentId|password|postgres(?:ql)?:\/\/|connectionString|stack|\.env|\bsql\b/i,
  );
  expect(serializedNotification).not.toMatch(
    /paymentToken|tok_approved|tok_declined|idempotency|fingerprint|inventoryReservationId|paymentId|password|postgres(?:ql)?:\/\/|connectionString|stack|\.env|\bsql\b/i,
  );
  return { outboxRows, notifications };
}

async function cleanupFixture(
  idempotencyKey: string,
  fixture: EventFixture,
): Promise<void> {
  await cleanupOrderInventoryFixture({
    idempotencyKey,
    sku: fixture.sku,
    totalQuantity: fixture.totalQuantity,
  });
  await purgeOrderEventQueues();
  expect(await countOrdersByIdempotencyKey(idempotencyKey)).toBe(0);
  expect(await countInventoryReservationsBySku(fixture.sku)).toBe(0);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  for (const port of [3001, 3002, 3003, 3004]) {
    expect(await isPortReachable(port)).toBe(false);
  }
  inventoryProcess = startInventoryService();
  paymentProcess = startPaymentService();
  notificationProcess = startNotificationService();
  orderProcess = startOrderService({ orderEventPublishIntervalMs: 100 });

  await waitForHealth(serviceUrls.inventory, {
    service: 'inventory-service',
    status: 'UP',
    dependencies: { database: 'UP' },
  });
  await waitForHealth(serviceUrls.payment, {
    service: 'payment-service',
    status: 'UP',
    dependencies: { database: 'UP' },
  });
  await waitForHealth(serviceUrls.order, {
    service: 'order-service',
    status: 'UP',
    dependencies: { database: 'UP' },
  });
  await waitForHealth(serviceUrls.notification, {
    service: 'notification-service',
    status: 'UP',
    dependencies: { database: 'UP', rabbitmq: 'UP' },
  });
});

test.afterAll(async () => {
  await orderProcess?.stop();
  await notificationProcess?.stop();
  await paymentProcess?.stop();
  await inventoryProcess?.stop();
  await purgeOrderEventQueues();
  for (const port of [3001, 3002, 3003, 3004]) {
    await expect.poll(() => isPortReachable(port)).toBe(false);
  }
});

test('delivers ORDER_CONFIRMED once and preserves terminal replay idempotency', async ({
  request,
}) => {
  const fixture = orderInventoryFixtures.eventConfirmed;
  const idempotencyKey = `order-event-confirmed-${randomUUID()}`;
  const correlationId = `correlation-${randomUUID()}`;

  await cleanupFixture(idempotencyKey, fixture);
  try {
    const creation = await readPublicOrder(
      await postOrder(
        request,
        idempotencyKey,
        correlationId,
        fixture.sku,
      ),
      201,
      'CONFIRMED',
    );
    const delivered = await expectTerminalDelivery({
      orderId: creation.orderId,
      eventType: 'ORDER_CONFIRMED',
      status: 'CONFIRMED',
      correlationId,
      failureCode: null,
      message: 'Order confirmed.',
    });
    expect(delivered.outboxRows[0]?.payload).toMatchObject({
      eventId: delivered.outboxRows[0]?.eventId,
      eventType: 'ORDER_CONFIRMED',
      eventVersion: 1,
      correlationId,
      orderId: creation.orderId,
      data: {
        status: 'CONFIRMED',
        sku: fixture.sku,
        quantity: 2,
        amountInCents: 5990,
        currency: 'BRL',
        failureCode: null,
      },
    });

    const replayCorrelationId = `correlation-${randomUUID()}`;
    const replayResponse = await postOrder(
      request,
      idempotencyKey,
      replayCorrelationId,
      fixture.sku,
    );
    expect(replayResponse.headers()['idempotent-replay']).toBe('true');
    expect(await readPublicOrder(replayResponse, 200, 'CONFIRMED')).toEqual(
      creation,
    );
    expect(await readOrderOutboxByOrderId(creation.orderId)).toEqual(
      delivered.outboxRows,
    );
    expect(await readNotificationsByOrderId(creation.orderId)).toEqual(
      delivered.notifications,
    );
  } finally {
    await cleanupFixture(idempotencyKey, fixture);
  }
});

test('delivers ORDER_INVENTORY_REJECTED without creating Payment', async ({
  request,
}) => {
  const fixture = orderInventoryFixtures.eventInventoryRejected;
  const idempotencyKey = `order-event-inventory-rejected-${randomUUID()}`;
  const correlationId = `correlation-${randomUUID()}`;
  await cleanupOrderByIdempotencyKey(idempotencyKey);

  try {
    const order = await readPublicOrder(
      await postOrder(
        request,
        idempotencyKey,
        correlationId,
        fixture.sku,
      ),
      201,
      'INVENTORY_REJECTED',
    );
    expect(await countPaymentsByOrderId(order.orderId)).toBe(0);
    expect(await readInventoryReservationsByOrderId(order.orderId)).toHaveLength(
      0,
    );
    await expectTerminalDelivery({
      orderId: order.orderId,
      eventType: 'ORDER_INVENTORY_REJECTED',
      status: 'INVENTORY_REJECTED',
      correlationId,
      failureCode: 'INVENTORY_ITEM_NOT_FOUND',
      message: 'Order rejected because inventory could not be reserved.',
    });
  } finally {
    await cleanupOrderByIdempotencyKey(idempotencyKey);
    await purgeOrderEventQueues();
  }
});

test('delivers ORDER_PAYMENT_DECLINED after releasing Inventory', async ({
  request,
}) => {
  const fixture = orderInventoryFixtures.eventPaymentDeclined;
  const idempotencyKey = `order-event-payment-declined-${randomUUID()}`;
  const correlationId = `correlation-${randomUUID()}`;
  await cleanupFixture(idempotencyKey, fixture);

  try {
    const order = await readPublicOrder(
      await postOrder(
        request,
        idempotencyKey,
        correlationId,
        fixture.sku,
        'tok_declined',
      ),
      201,
      'PAYMENT_DECLINED',
    );
    const payments = await readPaymentsByOrderId(order.orderId);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      status: 'DECLINED',
      declineCode: 'CARD_DECLINED',
    });
    const reservations = await readInventoryReservationsByOrderId(order.orderId);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.status).toBe('RELEASED');
    expect(await readInventoryProduct(fixture.sku)).toEqual({
      sku: fixture.sku,
      totalQuantity: fixture.totalQuantity,
      reservedQuantity: 0,
      availableQuantity: fixture.totalQuantity,
    });
    await expectTerminalDelivery({
      orderId: order.orderId,
      eventType: 'ORDER_PAYMENT_DECLINED',
      status: 'PAYMENT_DECLINED',
      correlationId,
      failureCode: 'CARD_DECLINED',
      message: 'Order payment was declined.',
    });
  } finally {
    await cleanupFixture(idempotencyKey, fixture);
  }
});

test('creates one outbox event and one Notification for concurrent requests', async ({
  request,
}) => {
  const fixture = orderInventoryFixtures.eventConcurrent;
  const idempotencyKey = `order-event-concurrent-${randomUUID()}`;
  const firstCorrelationId = `correlation-${randomUUID()}`;
  const secondCorrelationId = `correlation-${randomUUID()}`;
  await cleanupFixture(idempotencyKey, fixture);

  try {
    const responses = await Promise.all([
      postOrder(request, idempotencyKey, firstCorrelationId, fixture.sku),
      postOrder(request, idempotencyKey, secondCorrelationId, fixture.sku),
    ]);
    expect(responses.map((response) => response.status()).sort()).toEqual([
      200, 201,
    ]);
    const bodies = await Promise.all(
      responses.map((response) => response.json() as Promise<PublicOrder>),
    );
    expect(bodies[0]?.orderId).toBe(bodies[1]?.orderId);
    const orderId = bodies[0]!.orderId;
    const orderRows = await readOrderByIdempotencyKey(idempotencyKey);
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0]?.status).toBe('CONFIRMED');
    expect(await readInventoryReservationsByOrderId(orderId)).toHaveLength(1);
    expect(await readPaymentsByOrderId(orderId)).toHaveLength(1);

    await expect
      .poll(async () => (await readNotificationsByOrderId(orderId)).length)
      .toBe(1);
    expect(await readOrderOutboxByOrderId(orderId)).toHaveLength(1);
    expect(await readNotificationsByOrderId(orderId)).toHaveLength(1);
    expect((await readInventoryProduct(fixture.sku))?.reservedQuantity).toBe(2);
  } finally {
    await cleanupFixture(idempotencyKey, fixture);
  }
});
