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
} from '../../support/order-inventory-database.js';
import { orderInventoryFixtures } from '../../support/order-inventory-fixtures.js';
import {
  startInventoryMockServer,
  type InventoryMockServer,
} from '../../support/inventory-mock-server.js';
import {
  getPostgresStatus,
  getRabbitMqStatus,
  startPostgres,
  stopPostgres,
} from '../../support/docker-compose.js';
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

interface ServiceLog {
  errorCode?: string;
  errorName?: string;
  level?: string;
  message?: string;
  operation?: string;
  service?: string;
}

interface OrderResponse {
  orderId: string;
  sku: string;
  quantity: number;
  amountInCents: number;
  currency: string;
  status: string;
  createdAt: string;
}

interface ResilienceFixture {
  sku: string;
  totalQuantity: number;
}

const inventoryUrl = 'http://127.0.0.1:3002';
const healthyBody = {
  service: 'order-service',
  status: 'UP',
  dependencies: { database: 'UP' },
};
const degradedBody = {
  service: 'order-service',
  status: 'DEGRADED',
  dependencies: { database: 'DOWN' },
};
const inventoryUnavailableBody = {
  code: 'ORDER_INVENTORY_UNAVAILABLE',
  message: 'Inventory service is temporarily unavailable.',
};
const approvedOrderFields = [
  'amountInCents',
  'createdAt',
  'currency',
  'orderId',
  'quantity',
  'sku',
  'status',
];

function createOrderBody(sku: string) {
  return {
    sku,
    quantity: 2,
    amountInCents: 5990,
    currency: 'BRL',
    paymentToken: 'tok_approved',
  };
}

async function expectHealth(
  response: APIResponse,
  status: number,
  body: unknown,
): Promise<void> {
  expect(response.status()).toBe(status);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  const responseBody = (await response.json()) as unknown;
  expect(responseBody).toEqual(body);
  expect(JSON.stringify(responseBody)).not.toMatch(
    /qa_password|postgres(?:ql)?|connectionstring|stack|\.env|\bsql\b|\bselect\b|127\.0\.0\.1:5433|localhost:5433|[a-z]:\\|\/services\/|node_modules|econnrefused/i,
  );
}

function parseLogs(rawLogs: string): ServiceLog[] {
  return rawLogs
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ServiceLog];
      } catch {
        return [];
      }
    });
}

async function readOrderResponse(
  response: APIResponse,
  expectedStatus: number,
  expectedOrderStatus: string,
): Promise<OrderResponse> {
  expect(response.status()).toBe(expectedStatus);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  const body = (await response.json()) as OrderResponse;
  expect(Object.keys(body).sort()).toEqual(approvedOrderFields);
  expect(body.orderId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
  expect(body.status).toBe(expectedOrderStatus);
  expect(body).not.toHaveProperty('paymentToken');
  expect(body).not.toHaveProperty('correlationId');
  return body;
}

async function expectInventoryUnavailable(response: APIResponse): Promise<void> {
  expect(response.status()).toBe(503);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  expect(response.headers()).not.toHaveProperty('idempotent-replay');
  const body = (await response.json()) as unknown;
  expect(body).toEqual(inventoryUnavailableBody);
  expect(body).not.toHaveProperty('correlationId');
  expect(JSON.stringify(body)).not.toMatch(
    /tok_approved|paymentToken|idempotency|password|postgres(?:ql)?:\/\/|connectionstring|stack|\.env|\bsql\b|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|node_modules|services[\\/]|[a-z]:\\/i,
  );
}

async function postOrder(
  request: APIRequestContext,
  idempotencyKey: string,
  correlationId: string,
  sku: string,
): Promise<APIResponse> {
  return request.post('/orders', {
    headers: {
      'Idempotency-Key': idempotencyKey,
      'X-Correlation-Id': correlationId,
    },
    data: createOrderBody(sku),
    timeout: 10_000,
  });
}

async function expectInitialState(fixture: ResilienceFixture): Promise<void> {
  expect(await countInventoryReservationsBySku(fixture.sku)).toBe(0);
  expect(await readInventoryProduct(fixture.sku)).toEqual({
    sku: fixture.sku,
    totalQuantity: fixture.totalQuantity,
    reservedQuantity: 0,
    availableQuantity: fixture.totalQuantity,
  });
}

async function expectPendingState(
  idempotencyKey: string,
  fixture: ResilienceFixture,
) {
  expect(await countOrdersByIdempotencyKey(idempotencyKey)).toBe(1);
  const rows = await readOrderByIdempotencyKey(idempotencyKey);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row).toBeDefined();
  expect(row).toMatchObject({
    sku: fixture.sku,
    quantity: 2,
    amount: 5990,
    currency: 'BRL',
    status: 'PENDING',
    inventoryReservationId: null,
    paymentId: null,
    failureCode: null,
    idempotencyKey,
  });
  expect(await readInventoryReservationsByOrderId(row!.orderId)).toHaveLength(0);
  await expectInitialState(fixture);
  return row!;
}

async function waitForInventoryHealth(): Promise<void> {
  await expect
    .poll(async () => {
      try {
        const response = await fetch(`${inventoryUrl}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        return response.status === 200 ? response.json() : null;
      } catch {
        return null;
      }
    })
    .toEqual({
      service: 'inventory-service',
      status: 'UP',
      dependencies: { database: 'UP' },
    });
}

async function expectRecoveredOrder({
  firstCorrelationId,
  fixture,
  idempotencyKey,
  pendingCreatedAt,
  pendingOrderId,
  request,
}: {
  firstCorrelationId: string;
  fixture: ResilienceFixture;
  idempotencyKey: string;
  pendingCreatedAt: Date;
  pendingOrderId: string;
  request: APIRequestContext;
}): Promise<void> {
  const recoveryCorrelationId = `correlation-${randomUUID()}`;
  expect(recoveryCorrelationId).not.toBe(firstCorrelationId);
  const recoveryResponse = await postOrder(
    request,
    idempotencyKey,
    recoveryCorrelationId,
    fixture.sku,
  );
  expect(recoveryResponse.headers()['idempotent-replay']).toBe('true');
  const recoveredOrder = await readOrderResponse(
    recoveryResponse,
    200,
    'INVENTORY_RESERVED',
  );
  expect(recoveredOrder).toEqual({
    orderId: pendingOrderId,
    sku: fixture.sku,
    quantity: 2,
    amountInCents: 5990,
    currency: 'BRL',
    status: 'INVENTORY_RESERVED',
    createdAt: pendingCreatedAt.toISOString(),
  });

  const orderRows = await readOrderByIdempotencyKey(idempotencyKey);
  expect(orderRows).toHaveLength(1);
  expect(orderRows[0]).toMatchObject({
    orderId: pendingOrderId,
    status: 'INVENTORY_RESERVED',
    paymentId: null,
    failureCode: null,
  });
  expect(orderRows[0]?.inventoryReservationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

  const reservations = await readInventoryReservationsByOrderId(pendingOrderId);
  expect(reservations).toHaveLength(1);
  expect(reservations[0]).toMatchObject({
    reservationId: orderRows[0]?.inventoryReservationId,
    orderId: pendingOrderId,
    sku: fixture.sku,
    quantity: 2,
    status: 'RESERVED',
  });
  expect(await readInventoryProduct(fixture.sku)).toEqual({
    sku: fixture.sku,
    totalQuantity: fixture.totalQuantity,
    reservedQuantity: 2,
    availableQuantity: fixture.totalQuantity - 2,
  });

  const terminalCorrelationId = `correlation-${randomUUID()}`;
  expect(terminalCorrelationId).not.toBe(firstCorrelationId);
  expect(terminalCorrelationId).not.toBe(recoveryCorrelationId);
  const terminalReplayResponse = await postOrder(
    request,
    idempotencyKey,
    terminalCorrelationId,
    fixture.sku,
  );
  expect(terminalReplayResponse.headers()['idempotent-replay']).toBe('true');
  const terminalOrder = await readOrderResponse(
    terminalReplayResponse,
    200,
    'INVENTORY_RESERVED',
  );
  expect(terminalOrder).toEqual(recoveredOrder);
  expect(await countOrdersByIdempotencyKey(idempotencyKey)).toBe(1);
  expect(await countInventoryReservationsBySku(fixture.sku)).toBe(1);
  expect((await readInventoryProduct(fixture.sku))?.reservedQuantity).toBe(2);
}

function expectMockRequest(
  mock: InventoryMockServer,
  correlationId: string,
  orderId: string,
  sku: string,
): void {
  expect(mock.requests()).toHaveLength(1);
  const observedRequest = mock.requests()[0];
  expect(observedRequest).toBeDefined();
  expect(observedRequest).toMatchObject({
    method: 'POST',
    url: '/reservations',
  });
  expect(observedRequest?.headers['x-correlation-id']).toBe(correlationId);
  expect(observedRequest?.headers['idempotency-key']).toBe(
    `order:${orderId}:inventory-reservation`,
  );
  expect(JSON.parse(observedRequest?.body ?? '')).toEqual({
    orderId,
    sku,
    quantity: 2,
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
  await expectInitialState(fixture);
}

test('returns 503 during a database outage and recovers without restarting', async ({
  request,
}) => {
  await expect.poll(async () => (await getPostgresStatus()).Health).toBe('healthy');
  await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');

  const orderProcess = startOrderService({ inventoryServiceUrl: inventoryUrl });
  const initialPid = orderProcess.pid;
  console.log(JSON.stringify({ phase: 'initial', pid: initialPid, isRunning: true }));

  try {
    await expect.poll(() => isOrderPortReachable()).toBe(true);
    await expectHealth(await request.get('/health'), 200, healthyBody);
    expect(orderProcess.isRunning()).toBe(true);

    await stopPostgres();
    await expect
      .poll(async () => (await getPostgresStatus()).State.toLowerCase())
      .toMatch(/exited|stopped/u);
    await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');
    expect(orderProcess.isRunning()).toBe(true);
    expect(orderProcess.pid).toBe(initialPid);
    console.log(
      JSON.stringify({
        phase: 'database-outage',
        pid: orderProcess.pid,
        isRunning: orderProcess.isRunning(),
      }),
    );

    await expectHealth(await request.get('/health'), 503, degradedBody);
    expect(orderProcess.isRunning()).toBe(true);
    expect(orderProcess.pid).toBe(initialPid);

    await expect
      .poll(() =>
        parseLogs(orderProcess.logs()).some(
          (entry) =>
            entry.level === 'error' &&
            entry.service === 'order-service' &&
            (entry.operation === 'postgres-pool' ||
              entry.operation === 'database-health-check'),
        ),
      )
      .toBe(true);
    const errorLogs = parseLogs(orderProcess.logs()).filter(
      (entry) => entry.level === 'error',
    );
    expect(errorLogs.length).toBeGreaterThan(0);
    for (const errorLog of errorLogs) {
      expect(errorLog.service).toBe('order-service');
      expect(errorLog.operation).toMatch(
        /^(?:postgres-pool|database-health-check)$/u,
      );
      expect(errorLog.message).toEqual(expect.any(String));
    }
    expect(JSON.stringify(errorLogs)).not.toMatch(
      /ORDER_DATABASE_URL|qa_password|postgresql:\/\/|connectionstring|stack|\.env|SELECT 1|127\.0\.0\.1:5433|localhost:5433/i,
    );

    await startPostgres();
    await expect.poll(async () => (await getPostgresStatus()).Health).toBe('healthy');
    await expect
      .poll(async () => {
        try {
          const response = await request.get('/health');
          return response.status() === 200 ? response.json() : null;
        } catch {
          return null;
        }
      })
      .toEqual(healthyBody);
    await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');
    expect(orderProcess.isRunning()).toBe(true);
    expect(orderProcess.pid).toBe(initialPid);
    await expectHealth(await request.get('/health'), 200, healthyBody);
    console.log(
      JSON.stringify({
        phase: 'recovered',
        pid: orderProcess.pid,
        isRunning: orderProcess.isRunning(),
      }),
    );
  } finally {
    await startPostgres();
    await expect.poll(async () => (await getPostgresStatus()).Health).toBe('healthy');
    await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');
    await orderProcess.stop();
    await expect.poll(() => isOrderPortReachable()).toBe(false);
    await expect.poll(() => isPortReachable(3002)).toBe(false);
    await expect.poll(() => isPortReachable(3003)).toBe(false);
  }
});

test('recovers a pending order after Inventory becomes available', async ({
  request,
}) => {
  const fixture = orderInventoryFixtures.resilience;
  const idempotencyKey = `order-resilience-unavailable-${randomUUID()}`;
  const firstCorrelationId = `correlation-${randomUUID()}`;
  let inventoryProcess: InventoryServiceProcess | undefined;

  await cleanupScenario(idempotencyKey, fixture);
  await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');
  await expect.poll(() => isPortReachable(3002)).toBe(false);
  const orderProcess = startOrderService({ inventoryServiceUrl: inventoryUrl });

  try {
    await expect.poll(() => isOrderPortReachable()).toBe(true);
    const unavailableResponse = await postOrder(
      request,
      idempotencyKey,
      firstCorrelationId,
      fixture.sku,
    );
    await expectInventoryUnavailable(unavailableResponse);
    const pendingOrder = await expectPendingState(idempotencyKey, fixture);

    inventoryProcess = startInventoryService();
    await waitForInventoryHealth();
    await expectRecoveredOrder({
      firstCorrelationId,
      fixture,
      idempotencyKey,
      pendingCreatedAt: pendingOrder.createdAt,
      pendingOrderId: pendingOrder.orderId,
      request,
    });
  } finally {
    await inventoryProcess?.stop();
    await orderProcess.stop();
    await cleanupScenario(idempotencyKey, fixture);
    await expect.poll(() => isOrderPortReachable()).toBe(false);
    await expect.poll(() => isPortReachable(3002)).toBe(false);
    await expect.poll(() => isPortReachable(3003)).toBe(false);
  }
});

test('keeps an order pending after an Inventory timeout and recovers without retrying automatically', async ({
  request,
}) => {
  const fixture = orderInventoryFixtures.resilienceTimeout;
  const idempotencyKey = `order-resilience-timeout-${randomUUID()}`;
  const firstCorrelationId = `correlation-${randomUUID()}`;
  let mock: InventoryMockServer | undefined;
  let inventoryProcess: InventoryServiceProcess | undefined;
  let orderProcess: OrderServiceProcess | undefined;

  await cleanupScenario(idempotencyKey, fixture);

  try {
    mock = await startInventoryMockServer({
      response: { status: 201, body: { status: 'RESERVED' }, delayMs: 750 },
    });
    orderProcess = startOrderService({
      inventoryServiceUrl: inventoryUrl,
      inventoryRequestTimeoutMs: 200,
    });
    await expect.poll(() => isOrderPortReachable()).toBe(true);

    const unavailableResponse = await postOrder(
      request,
      idempotencyKey,
      firstCorrelationId,
      fixture.sku,
    );
    await expectInventoryUnavailable(unavailableResponse);
    const pendingOrder = await expectPendingState(idempotencyKey, fixture);
    await expect.poll(() => mock?.requests().length).toBe(1);
    expectMockRequest(
      mock,
      firstCorrelationId,
      pendingOrder.orderId,
      fixture.sku,
    );

    await mock.stop();
    mock = undefined;
    inventoryProcess = startInventoryService();
    await waitForInventoryHealth();
    await expectRecoveredOrder({
      firstCorrelationId,
      fixture,
      idempotencyKey,
      pendingCreatedAt: pendingOrder.createdAt,
      pendingOrderId: pendingOrder.orderId,
      request,
    });
  } finally {
    await inventoryProcess?.stop();
    await mock?.stop();
    await orderProcess?.stop();
    await cleanupScenario(idempotencyKey, fixture);
    await expect.poll(() => isOrderPortReachable()).toBe(false);
    await expect.poll(() => isPortReachable(3002)).toBe(false);
  }
});

test('keeps an order pending after an unexpected Inventory 409 and recovers', async ({
  request,
}) => {
  const fixture = orderInventoryFixtures.resilienceUnexpected409;
  const idempotencyKey = `order-resilience-unexpected-409-${randomUUID()}`;
  const firstCorrelationId = `correlation-${randomUUID()}`;
  let mock: InventoryMockServer | undefined;
  let inventoryProcess: InventoryServiceProcess | undefined;
  let orderProcess: OrderServiceProcess | undefined;

  await cleanupScenario(idempotencyKey, fixture);

  try {
    mock = await startInventoryMockServer({
      response: {
        status: 409,
        body: {
          code: 'IDEMPOTENCY_KEY_CONFLICT',
          message: 'The idempotency key was already used with a different request.',
        },
      },
    });
    orderProcess = startOrderService({ inventoryServiceUrl: inventoryUrl });
    await expect.poll(() => isOrderPortReachable()).toBe(true);

    const unavailableResponse = await postOrder(
      request,
      idempotencyKey,
      firstCorrelationId,
      fixture.sku,
    );
    await expectInventoryUnavailable(unavailableResponse);
    const pendingOrder = await expectPendingState(idempotencyKey, fixture);
    expectMockRequest(
      mock,
      firstCorrelationId,
      pendingOrder.orderId,
      fixture.sku,
    );

    await mock.stop();
    mock = undefined;
    inventoryProcess = startInventoryService();
    await waitForInventoryHealth();
    await expectRecoveredOrder({
      firstCorrelationId,
      fixture,
      idempotencyKey,
      pendingCreatedAt: pendingOrder.createdAt,
      pendingOrderId: pendingOrder.orderId,
      request,
    });
  } finally {
    await inventoryProcess?.stop();
    await mock?.stop();
    await orderProcess?.stop();
    await cleanupScenario(idempotencyKey, fixture);
    await expect.poll(() => isOrderPortReachable()).toBe(false);
    await expect.poll(() => isPortReachable(3002)).toBe(false);
  }
});

test('keeps an order pending after an invalid Inventory success contract and recovers', async ({
  request,
}) => {
  const fixture = orderInventoryFixtures.resilienceInvalidContract;
  const idempotencyKey = `order-resilience-invalid-contract-${randomUUID()}`;
  const firstCorrelationId = `correlation-${randomUUID()}`;
  let mock: InventoryMockServer | undefined;
  let inventoryProcess: InventoryServiceProcess | undefined;
  let orderProcess: OrderServiceProcess | undefined;

  await cleanupScenario(idempotencyKey, fixture);

  try {
    mock = await startInventoryMockServer({
      response: { status: 201, body: { status: 'RESERVED' } },
    });
    orderProcess = startOrderService({ inventoryServiceUrl: inventoryUrl });
    await expect.poll(() => isOrderPortReachable()).toBe(true);

    const unavailableResponse = await postOrder(
      request,
      idempotencyKey,
      firstCorrelationId,
      fixture.sku,
    );
    await expectInventoryUnavailable(unavailableResponse);
    const pendingOrder = await expectPendingState(idempotencyKey, fixture);
    expectMockRequest(
      mock,
      firstCorrelationId,
      pendingOrder.orderId,
      fixture.sku,
    );

    await mock.stop();
    mock = undefined;
    inventoryProcess = startInventoryService();
    await waitForInventoryHealth();
    await expectRecoveredOrder({
      firstCorrelationId,
      fixture,
      idempotencyKey,
      pendingCreatedAt: pendingOrder.createdAt,
      pendingOrderId: pendingOrder.orderId,
      request,
    });
  } finally {
    await inventoryProcess?.stop();
    await mock?.stop();
    await orderProcess?.stop();
    await cleanupScenario(idempotencyKey, fixture);
    await expect.poll(() => isOrderPortReachable()).toBe(false);
    await expect.poll(() => isPortReachable(3002)).toBe(false);
  }
});
