import { randomUUID } from 'node:crypto';

import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';

import {
  cleanupOrderInventoryFixture,
  countInventoryReservationsBySku,
  countOrdersByIdempotencyKey,
  readInventoryProduct,
  readInventoryReservationsByOrderId,
  readOrderByIdempotencyKey,
  type OrderDatabaseRow,
} from '../../support/order-inventory-database.js';
import { orderInventoryFixtures } from '../../support/order-inventory-fixtures.js';
import {
  startInventoryMockServer,
  type InventoryMockServer,
} from '../../support/inventory-mock-server.js';
import {
  isPortReachable,
  startInventoryService,
  type InventoryServiceProcess,
} from '../../support/inventory-service-process.js';
import {
  isOrderPortReachable,
  startOrderService,
  type OrderServiceProcess,
} from '../../support/order-service-process.js';
import {
  countPaymentsByOrderId,
  readPaymentsByOrderId,
} from '../../support/order-payment-database.js';
import {
  startPaymentMockServer,
  type PaymentMockServer,
} from '../../support/payment-mock-server.js';
import {
  startPaymentService,
  type PaymentServiceProcess,
} from '../../support/payment-service-process.js';

interface ResilienceFixture {
  sku: string;
  totalQuantity: number;
}

interface PublicOrder {
  amountInCents: number;
  createdAt: string;
  currency: string;
  orderId: string;
  quantity: number;
  sku: string;
  status: string;
}

const inventoryUrl = 'http://127.0.0.1:3002';
const paymentUrl = 'http://127.0.0.1:3003';
const inventoryProxyUrl = 'http://127.0.0.1:3004';
const publicOrderFields = [
  'amountInCents',
  'createdAt',
  'currency',
  'orderId',
  'quantity',
  'sku',
  'status',
];
const paymentUnavailableBody = {
  code: 'ORDER_PAYMENT_UNAVAILABLE',
  message: 'Payment service is temporarily unavailable.',
};
const compensationFailedBody = {
  code: 'ORDER_COMPENSATION_FAILED',
  message:
    'The payment was declined and the inventory reservation could not be released.',
};

function orderBody(sku: string, paymentToken = 'tok_approved') {
  return {
    sku,
    quantity: 2,
    amountInCents: 5990,
    currency: 'BRL',
    paymentToken,
  };
}

async function postOrder(
  request: APIRequestContext,
  idempotencyKey: string,
  correlationId: string,
  fixture: ResilienceFixture,
  paymentToken = 'tok_approved',
): Promise<APIResponse> {
  return request.post('/orders', {
    headers: {
      'Idempotency-Key': idempotencyKey,
      'X-Correlation-Id': correlationId,
    },
    data: orderBody(fixture.sku, paymentToken),
    timeout: 10_000,
  });
}

async function expectControlledError(
  response: APIResponse,
  expectedBody: unknown,
): Promise<void> {
  expect(response.status()).toBe(503);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  expect(response.headers()).not.toHaveProperty('idempotent-replay');
  const body = (await response.json()) as unknown;
  expect(body).toEqual(expectedBody);
  expect(JSON.stringify(body)).not.toMatch(
    /tok_approved|tok_declined|paymentToken|idempotency|fingerprint|reservationId|paymentId|password|postgres(?:ql)?:\/\/|connectionstring|stack|\.env|\bsql\b|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|node_modules|services[\\/]|[a-z]:\\/i,
  );
}

async function readPublicOrder(
  response: APIResponse,
  expectedStatus: string,
): Promise<PublicOrder> {
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  const body = (await response.json()) as PublicOrder;
  expect(Object.keys(body).sort()).toEqual(publicOrderFields);
  expect(body.status).toBe(expectedStatus);
  expect(body.orderId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
  expect(body).not.toHaveProperty('paymentToken');
  expect(body).not.toHaveProperty('inventoryReservationId');
  expect(body).not.toHaveProperty('paymentId');
  expect(body).not.toHaveProperty('failureCode');
  return body;
}

async function waitForHealth(url: string, service: string): Promise<void> {
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
    .toEqual({
      service,
      status: 'UP',
      dependencies: { database: 'UP' },
    });
}

async function cleanupScenario(
  idempotencyKey: string,
  fixture: ResilienceFixture,
): Promise<void> {
  await cleanupOrderInventoryFixture({
    idempotencyKey,
    sku: fixture.sku,
    totalQuantity: fixture.totalQuantity,
  });
  expect(await countOrdersByIdempotencyKey(idempotencyKey)).toBe(0);
  expect(await countInventoryReservationsBySku(fixture.sku)).toBe(0);
  expect(await readInventoryProduct(fixture.sku)).toEqual({
    sku: fixture.sku,
    totalQuantity: fixture.totalQuantity,
    reservedQuantity: 0,
    availableQuantity: fixture.totalQuantity,
  });
}

async function expectInventoryReservedState(
  idempotencyKey: string,
  fixture: ResilienceFixture,
): Promise<OrderDatabaseRow> {
  const orders = await readOrderByIdempotencyKey(idempotencyKey);
  expect(orders).toHaveLength(1);
  const order = orders[0];
  expect(order).toBeDefined();
  expect(order).toMatchObject({
    sku: fixture.sku,
    quantity: 2,
    amount: 5990,
    currency: 'BRL',
    status: 'INVENTORY_RESERVED',
    paymentId: null,
    failureCode: null,
    idempotencyKey,
  });
  expect(order?.inventoryReservationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

  const reservations = await readInventoryReservationsByOrderId(order!.orderId);
  expect(reservations).toHaveLength(1);
  expect(reservations[0]).toMatchObject({
    reservationId: order?.inventoryReservationId,
    orderId: order?.orderId,
    sku: fixture.sku,
    quantity: 2,
    status: 'RESERVED',
    releaseIdempotencyKey: null,
    releaseRequestFingerprint: null,
    releasedAt: null,
  });
  expect(await readInventoryProduct(fixture.sku)).toEqual({
    sku: fixture.sku,
    totalQuantity: fixture.totalQuantity,
    reservedQuantity: 2,
    availableQuantity: fixture.totalQuantity - 2,
  });
  expect(await countPaymentsByOrderId(order!.orderId)).toBe(0);
  return order!;
}

function expectPaymentRequest(
  mock: PaymentMockServer,
  correlationId: string,
  orderId: string,
): void {
  expect(mock.requests()).toHaveLength(1);
  const observed = mock.requests()[0];
  expect(observed).toMatchObject({ method: 'POST', url: '/payments' });
  expect(observed?.headers['idempotency-key']).toBe(
    `order:${orderId}:payment`,
  );
  expect(observed?.headers['x-correlation-id']).toBe(correlationId);
  expect(JSON.parse(observed?.body ?? '')).toEqual({
    orderId,
    amountInCents: 5990,
    currency: 'BRL',
    paymentToken: 'tok_approved',
  });
}

async function expectFailureLog(
  orderProcess: OrderServiceProcess,
  operation: string,
  errorCode: string,
): Promise<void> {
  await expect
    .poll(() =>
      orderProcess
        .logs()
        .split(/\r?\n/u)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        })
        .some(
          (entry) =>
            entry.operation === operation && entry.errorCode === errorCode,
        ),
    )
    .toBe(true);
  expect(orderProcess.logs()).not.toMatch(
    /tok_approved|tok_declined|paymentToken|qa_password|postgresql:\/\/|connectionstring|stack|\.env|\bsql\b|\bselect\b|node_modules|services[\\/]|[a-z]:\\/i,
  );
}

async function expectConfirmedRecovery({
  firstCorrelationId,
  fixture,
  idempotencyKey,
  originalOrder,
  request,
}: {
  firstCorrelationId: string;
  fixture: ResilienceFixture;
  idempotencyKey: string;
  originalOrder: OrderDatabaseRow;
  request: APIRequestContext;
}): Promise<void> {
  const recoveryCorrelationId = `correlation-${randomUUID()}`;
  expect(recoveryCorrelationId).not.toBe(firstCorrelationId);
  const recoveryResponse = await postOrder(
    request,
    idempotencyKey,
    recoveryCorrelationId,
    fixture,
  );
  expect(recoveryResponse.headers()['idempotent-replay']).toBe('true');
  const publicOrder = await readPublicOrder(recoveryResponse, 'CONFIRMED');
  expect(publicOrder).toEqual({
    orderId: originalOrder.orderId,
    sku: fixture.sku,
    quantity: 2,
    amountInCents: 5990,
    currency: 'BRL',
    status: 'CONFIRMED',
    createdAt: originalOrder.createdAt.toISOString(),
  });

  const orders = await readOrderByIdempotencyKey(idempotencyKey);
  expect(orders).toHaveLength(1);
  expect(orders[0]).toMatchObject({
    orderId: originalOrder.orderId,
    status: 'CONFIRMED',
    inventoryReservationId: originalOrder.inventoryReservationId,
    failureCode: null,
  });
  expect(orders[0]?.paymentId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  const reservations = await readInventoryReservationsByOrderId(
    originalOrder.orderId,
  );
  expect(reservations).toHaveLength(1);
  expect(reservations[0]).toMatchObject({
    reservationId: originalOrder.inventoryReservationId,
    status: 'RESERVED',
  });
  expect(await readInventoryProduct(fixture.sku)).toEqual({
    sku: fixture.sku,
    totalQuantity: fixture.totalQuantity,
    reservedQuantity: 2,
    availableQuantity: fixture.totalQuantity - 2,
  });
  const payments = await readPaymentsByOrderId(originalOrder.orderId);
  expect(payments).toHaveLength(1);
  expect(payments[0]).toMatchObject({
    paymentId: orders[0]?.paymentId,
    orderId: originalOrder.orderId,
    amountInCents: 5990,
    currency: 'BRL',
    status: 'APPROVED',
    declineCode: null,
    idempotencyKey: `order:${originalOrder.orderId}:payment`,
  });
}

async function runRecoverablePaymentFailure({
  expectedErrorCode,
  fixture,
  mockResponse,
  request,
  timeoutMs,
}: {
  expectedErrorCode: string;
  fixture: ResilienceFixture;
  mockResponse?: { body: unknown; delayMs?: number; status: number };
  request: APIRequestContext;
  timeoutMs?: number;
}): Promise<void> {
  const idempotencyKey = `order-payment-resilience-${randomUUID()}`;
  const firstCorrelationId = `correlation-${randomUUID()}`;
  let inventoryProcess: InventoryServiceProcess | undefined;
  let mock: PaymentMockServer | undefined;
  let orderProcess: OrderServiceProcess | undefined;
  let paymentProcess: PaymentServiceProcess | undefined;

  await cleanupScenario(idempotencyKey, fixture);

  try {
    expect(await isPortReachable(3001)).toBe(false);
    expect(await isPortReachable(3002)).toBe(false);
    expect(await isPortReachable(3003)).toBe(false);
    inventoryProcess = startInventoryService();
    await waitForHealth(inventoryUrl, 'inventory-service');
    if (mockResponse !== undefined) {
      mock = await startPaymentMockServer({ response: mockResponse });
    }
    orderProcess = startOrderService({
      inventoryServiceUrl: inventoryUrl,
      paymentServiceUrl: paymentUrl,
      ...(timeoutMs === undefined
        ? {}
        : { paymentRequestTimeoutMs: timeoutMs }),
    });
    await expect.poll(() => isOrderPortReachable()).toBe(true);

    const failedResponse = await postOrder(
      request,
      idempotencyKey,
      firstCorrelationId,
      fixture,
    );
    await expectControlledError(failedResponse, paymentUnavailableBody);
    const originalOrder = await expectInventoryReservedState(
      idempotencyKey,
      fixture,
    );
    await expectFailureLog(
      orderProcess,
      'process-order-payment',
      expectedErrorCode,
    );

    if (mock !== undefined) {
      await expect.poll(() => mock?.requests().length).toBe(1);
      expectPaymentRequest(
        mock,
        firstCorrelationId,
        originalOrder.orderId,
      );
      await mock.stop();
      mock = undefined;
    }

    paymentProcess = startPaymentService();
    await waitForHealth(paymentUrl, 'payment-service');
    await expectConfirmedRecovery({
      firstCorrelationId,
      fixture,
      idempotencyKey,
      originalOrder,
      request,
    });
  } finally {
    await orderProcess?.stop();
    await paymentProcess?.stop();
    await mock?.stop();
    await inventoryProcess?.stop();
    await cleanupScenario(idempotencyKey, fixture);
    await expect.poll(() => isOrderPortReachable()).toBe(false);
    await expect.poll(() => isPortReachable(3002)).toBe(false);
    await expect.poll(() => isPortReachable(3003)).toBe(false);
  }
}

test('keeps Inventory reserved while Payment is unavailable and resumes the same order', async ({
  request,
}) => {
  await runRecoverablePaymentFailure({
    expectedErrorCode: 'PAYMENT_REQUEST_FAILED',
    fixture: orderInventoryFixtures.paymentUnavailable,
    request,
  });
});

test('times out Payment once and resumes without reserving Inventory again', async ({
  request,
}) => {
  await runRecoverablePaymentFailure({
    expectedErrorCode: 'PAYMENT_REQUEST_FAILED',
    fixture: orderInventoryFixtures.paymentTimeout,
    mockResponse: {
      status: 201,
      body: { status: 'APPROVED' },
      delayMs: 750,
    },
    request,
    timeoutMs: 200,
  });
});

test('rejects an invalid Payment success contract and resumes safely', async ({
  request,
}) => {
  await runRecoverablePaymentFailure({
    expectedErrorCode: 'PAYMENT_RESPONSE_INVALID',
    fixture: orderInventoryFixtures.paymentInvalidContract,
    mockResponse: { status: 201, body: { status: 'APPROVED' } },
    request,
  });
});

test('treats an unexpected Payment 500 as a recoverable technical failure', async ({
  request,
}) => {
  await runRecoverablePaymentFailure({
    expectedErrorCode: 'PAYMENT_RESPONSE_UNAVAILABLE',
    fixture: orderInventoryFixtures.paymentUnexpectedStatus,
    mockResponse: {
      status: 500,
      body: { code: 'PAYMENT_DATABASE_UNAVAILABLE' },
    },
    request,
  });
});

test('persists COMPENSATION_FAILED when Inventory release fails and keeps it terminal', async ({
  request,
}) => {
  const fixture = orderInventoryFixtures.compensationFailed;
  const idempotencyKey = `order-compensation-failed-${randomUUID()}`;
  const firstCorrelationId = `correlation-${randomUUID()}`;
  let inventoryProcess: InventoryServiceProcess | undefined;
  let inventoryProxy: InventoryMockServer | undefined;
  let orderProcess: OrderServiceProcess | undefined;
  let paymentProcess: PaymentServiceProcess | undefined;

  await cleanupScenario(idempotencyKey, fixture);

  try {
    expect(await isPortReachable(3001)).toBe(false);
    expect(await isPortReachable(3002)).toBe(false);
    expect(await isPortReachable(3003)).toBe(false);
    expect(await isPortReachable(3004)).toBe(false);
    inventoryProcess = startInventoryService();
    paymentProcess = startPaymentService();
    await waitForHealth(inventoryUrl, 'inventory-service');
    await waitForHealth(paymentUrl, 'payment-service');
    inventoryProxy = await startInventoryMockServer({
      port: 3004,
      response: async (observed) => {
        if (observed.url === '/reservations') {
          const inventoryResponse = await fetch(`${inventoryUrl}/reservations`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': String(
                observed.headers['idempotency-key'],
              ),
              'X-Correlation-Id': String(
                observed.headers['x-correlation-id'],
              ),
            },
            body: observed.body,
            signal: AbortSignal.timeout(2000),
          });
          return {
            status: inventoryResponse.status,
            body: (await inventoryResponse.json()) as unknown,
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
    orderProcess = startOrderService({
      inventoryServiceUrl: inventoryProxyUrl,
      paymentServiceUrl: paymentUrl,
    });
    await expect.poll(() => isOrderPortReachable()).toBe(true);

    const failedResponse = await postOrder(
      request,
      idempotencyKey,
      firstCorrelationId,
      fixture,
      'tok_declined',
    );
    await expectControlledError(failedResponse, compensationFailedBody);
    await expectFailureLog(
      orderProcess,
      'compensate-order-inventory',
      'INVENTORY_RELEASE_UNAVAILABLE',
    );

    const orders = await readOrderByIdempotencyKey(idempotencyKey);
    expect(orders).toHaveLength(1);
    const order = orders[0];
    expect(order).toMatchObject({
      sku: fixture.sku,
      status: 'COMPENSATION_FAILED',
      failureCode: 'INVENTORY_COMPENSATION_FAILED',
      idempotencyKey,
    });
    expect(order?.inventoryReservationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(order?.paymentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const payments = await readPaymentsByOrderId(order!.orderId);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      paymentId: order?.paymentId,
      orderId: order?.orderId,
      status: 'DECLINED',
      declineCode: 'CARD_DECLINED',
      idempotencyKey: `order:${order?.orderId}:payment`,
    });
    const reservations = await readInventoryReservationsByOrderId(
      order!.orderId,
    );
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({
      reservationId: order?.inventoryReservationId,
      status: 'RESERVED',
      releaseIdempotencyKey: null,
      releaseRequestFingerprint: null,
      releasedAt: null,
    });
    expect(await readInventoryProduct(fixture.sku)).toEqual({
      sku: fixture.sku,
      totalQuantity: fixture.totalQuantity,
      reservedQuantity: 2,
      availableQuantity: fixture.totalQuantity - 2,
    });

    expect(inventoryProxy.requests()).toHaveLength(2);
    expect(inventoryProxy.requests()[0]).toMatchObject({
      method: 'POST',
      url: '/reservations',
    });
    expect(inventoryProxy.requests()[0]?.headers['idempotency-key']).toBe(
      `order:${order?.orderId}:inventory-reservation`,
    );
    expect(inventoryProxy.requests()[0]?.headers['x-correlation-id']).toBe(
      firstCorrelationId,
    );
    expect(inventoryProxy.requests()[1]).toMatchObject({
      method: 'POST',
      url: `/reservations/${order?.inventoryReservationId}/release`,
    });
    expect(inventoryProxy.requests()[1]?.headers['idempotency-key']).toBe(
      `order:${order?.orderId}:inventory-release`,
    );
    expect(inventoryProxy.requests()[1]?.headers['x-correlation-id']).toBe(
      firstCorrelationId,
    );
    expect(inventoryProxy.requests()[1]?.body).toBe('');

    const originalUpdatedAt = order!.updatedAt;
    const replayCorrelationId = `correlation-${randomUUID()}`;
    expect(replayCorrelationId).not.toBe(firstCorrelationId);
    const replayResponse = await postOrder(
      request,
      idempotencyKey,
      replayCorrelationId,
      fixture,
      'tok_declined',
    );
    expect(replayResponse.headers()['idempotent-replay']).toBe('true');
    const replayOrder = await readPublicOrder(
      replayResponse,
      'COMPENSATION_FAILED',
    );
    expect(replayOrder.orderId).toBe(order?.orderId);
    expect(inventoryProxy.requests()).toHaveLength(2);
    expect(await countPaymentsByOrderId(order!.orderId)).toBe(1);
    expect(await countInventoryReservationsBySku(fixture.sku)).toBe(1);
    expect((await readOrderByIdempotencyKey(idempotencyKey))[0]?.updatedAt).toEqual(
      originalUpdatedAt,
    );
    expect((await readInventoryProduct(fixture.sku))?.reservedQuantity).toBe(2);
  } finally {
    await orderProcess?.stop();
    await inventoryProxy?.stop();
    await paymentProcess?.stop();
    await inventoryProcess?.stop();
    await cleanupScenario(idempotencyKey, fixture);
    await expect.poll(() => isOrderPortReachable()).toBe(false);
    await expect.poll(() => isPortReachable(3002)).toBe(false);
    await expect.poll(() => isPortReachable(3003)).toBe(false);
    await expect.poll(() => isPortReachable(3004)).toBe(false);
  }
});
