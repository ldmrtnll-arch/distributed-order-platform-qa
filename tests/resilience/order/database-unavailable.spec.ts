import { randomUUID } from 'node:crypto';

import { expect, test, type APIResponse } from '@playwright/test';

import { queryOrderDatabase } from '../../support/database.js';
import {
  getPostgresStatus,
  getRabbitMqStatus,
  startPostgres,
  stopPostgres,
} from '../../support/docker-compose.js';
import { isPortReachable } from '../../support/inventory-service-process.js';
import {
  isOrderPortReachable,
  startOrderService,
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

interface OrderRow {
  order_id: string;
  sku: string;
  quantity: number;
  amount: number;
  currency: string;
  status: string;
  inventory_reservation_id: string | null;
  payment_id: string | null;
  failure_code: string | null;
}

interface CountRow {
  count: number;
}

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
    .map((line) => JSON.parse(line) as ServiceLog);
}

async function countOrders(idempotencyKey: string): Promise<number> {
  const rows = await queryOrderDatabase<CountRow>(
    `
      SELECT COUNT(*)::integer AS count
      FROM orders
      WHERE idempotency_key = $1
    `,
    [idempotencyKey],
  );
  return rows[0]?.count ?? -1;
}

async function readPendingOrder(
  response: APIResponse,
  expectedStatus: number,
): Promise<OrderResponse> {
  expect(response.status()).toBe(expectedStatus);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  const body = (await response.json()) as OrderResponse;
  expect(Object.keys(body).sort()).toEqual([
    'amountInCents',
    'createdAt',
    'currency',
    'orderId',
    'quantity',
    'sku',
    'status',
  ]);
  expect(body.orderId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
  expect(body).not.toHaveProperty('paymentToken');
  return body;
}

test('returns 503 during a database outage and recovers without restarting', async ({
  request,
}) => {
  await expect.poll(async () => (await getPostgresStatus()).Health).toBe('healthy');
  await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');

  const serviceProcess = startOrderService();
  const initialPid = serviceProcess.pid;
  console.log(
    JSON.stringify({ phase: 'initial', pid: initialPid, isRunning: true }),
  );

  try {
    await expect.poll(() => isOrderPortReachable()).toBe(true);
    await expectHealth(await request.get('/health'), 200, healthyBody);
    expect(serviceProcess.isRunning()).toBe(true);

    await stopPostgres();
    await expect
      .poll(async () => (await getPostgresStatus()).State.toLowerCase())
      .toMatch(/exited|stopped/u);
    await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);
    console.log(
      JSON.stringify({
        phase: 'database-outage',
        pid: serviceProcess.pid,
        isRunning: serviceProcess.isRunning(),
      }),
    );

    await expectHealth(await request.get('/health'), 503, degradedBody);
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);

    await expect
      .poll(() =>
        parseLogs(serviceProcess.logs()).some(
          (entry) =>
            entry.level === 'error' &&
            entry.service === 'order-service' &&
            (entry.operation === 'postgres-pool' ||
              entry.operation === 'database-health-check'),
        ),
      )
      .toBe(true);
    const errorLogs = parseLogs(serviceProcess.logs()).filter(
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
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);
    await expectHealth(await request.get('/health'), 200, healthyBody);
    console.log(
      JSON.stringify({
        phase: 'recovered',
        pid: serviceProcess.pid,
        isRunning: serviceProcess.isRunning(),
      }),
    );
  } finally {
    await startPostgres();
    await expect.poll(async () => (await getPostgresStatus()).Health).toBe('healthy');
    await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');
    await serviceProcess.stop();
    await expect.poll(() => isOrderPortReachable()).toBe(false);
    await expect.poll(() => isPortReachable(3002)).toBe(false);
    await expect.poll(() => isPortReachable(3003)).toBe(false);
  }
});

test('recovers order creation after a database outage without consuming the idempotency key', async ({
  request,
}) => {
  const initialIdempotencyKey = `resilience-order-create-${randomUUID()}`;
  const outageIdempotencyKey = `resilience-order-create-${randomUUID()}`;
  const requestBody = {
    sku: 'RESILIENCE-ORDER-001',
    quantity: 2,
    amountInCents: 8990,
    currency: 'BRL',
    paymentToken: 'tok_approved',
  };

  await expect.poll(async () => (await getPostgresStatus()).Health).toBe('healthy');
  await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');

  const serviceProcess = startOrderService();
  const initialPid = serviceProcess.pid;
  console.log(
    JSON.stringify({ phase: 'initial', pid: initialPid, isRunning: true }),
  );

  try {
    await expect.poll(() => isOrderPortReachable()).toBe(true);
    await expectHealth(await request.get('/health'), 200, healthyBody);
    expect(serviceProcess.isRunning()).toBe(true);

    const initialCreationResponse = await request.post('/orders', {
      headers: {
        'Idempotency-Key': initialIdempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: requestBody,
    });
    expect(initialCreationResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    const initialOrder = await readPendingOrder(initialCreationResponse, 201);
    expect(initialOrder).toMatchObject({
      sku: 'RESILIENCE-ORDER-001',
      quantity: 2,
      amountInCents: 8990,
      currency: 'BRL',
      status: 'PENDING',
    });

    await stopPostgres();
    await expect
      .poll(async () => (await getPostgresStatus()).State.toLowerCase())
      .toMatch(/exited|stopped/u);
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);

    const unavailableResponse = await request.post('/orders', {
      headers: {
        'Idempotency-Key': outageIdempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: requestBody,
    });
    expect(unavailableResponse.status()).toBe(503);
    expect(unavailableResponse.headers()['content-type']).toMatch(
      /^application\/json(?:;|$)/,
    );
    expect(unavailableResponse.headers()).not.toHaveProperty('x-powered-by');
    expect(unavailableResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    const unavailableBody = (await unavailableResponse.json()) as unknown;
    expect(unavailableBody).toEqual({
      code: 'ORDER_DATABASE_UNAVAILABLE',
      message: 'Order data is temporarily unavailable.',
    });
    const serializedUnavailableBody = JSON.stringify(unavailableBody);
    expect(serializedUnavailableBody).not.toContain('tok_approved');
    expect(serializedUnavailableBody).not.toContain(outageIdempotencyKey);
    expect(serializedUnavailableBody).not.toMatch(
      /orderId|paymentToken|fingerprint|requestFingerprint|password|postgres(?:ql)?:\/\/[^\s"]+@|connectionstring|stack|\.env|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|node_modules|services[\\/]|[a-z]:\\/i,
    );
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);
    console.log(
      JSON.stringify({
        phase: 'database-outage',
        pid: serviceProcess.pid,
        isRunning: serviceProcess.isRunning(),
      }),
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
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);
    await expectHealth(await request.get('/health'), 200, healthyBody);

    expect(await countOrders(outageIdempotencyKey)).toBe(0);

    const recoveredCreationResponse = await request.post('/orders', {
      headers: {
        'Idempotency-Key': outageIdempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: requestBody,
    });
    expect(recoveredCreationResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    const recoveredOrder = await readPendingOrder(
      recoveredCreationResponse,
      201,
    );
    expect(recoveredOrder).toEqual({
      orderId: recoveredOrder.orderId,
      sku: 'RESILIENCE-ORDER-001',
      quantity: 2,
      amountInCents: 8990,
      currency: 'BRL',
      status: 'PENDING',
      createdAt: recoveredOrder.createdAt,
    });

    expect(await countOrders(outageIdempotencyKey)).toBe(1);
    const persistedRows = await queryOrderDatabase<OrderRow>(
      `
        SELECT
          order_id,
          sku,
          quantity,
          amount,
          currency,
          status,
          inventory_reservation_id,
          payment_id,
          failure_code
        FROM orders
        WHERE idempotency_key = $1
      `,
      [outageIdempotencyKey],
    );
    expect(persistedRows).toHaveLength(1);
    expect(persistedRows[0]).toEqual({
      order_id: recoveredOrder.orderId,
      sku: 'RESILIENCE-ORDER-001',
      quantity: 2,
      amount: 8990,
      currency: 'BRL',
      status: 'PENDING',
      inventory_reservation_id: null,
      payment_id: null,
      failure_code: null,
    });

    const replayResponse = await request.post('/orders', {
      headers: {
        'Idempotency-Key': outageIdempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: requestBody,
    });
    expect(replayResponse.headers()['idempotent-replay']).toBe('true');
    const replayedOrder = await readPendingOrder(replayResponse, 200);
    expect(replayedOrder).toEqual(recoveredOrder);
    expect(replayedOrder.orderId).toBe(recoveredOrder.orderId);
    expect(replayedOrder.createdAt).toBe(recoveredOrder.createdAt);
    expect(await countOrders(outageIdempotencyKey)).toBe(1);

    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);
    console.log(
      JSON.stringify({
        phase: 'recovered',
        pid: serviceProcess.pid,
        isRunning: serviceProcess.isRunning(),
        failedOrderRows: 0,
        recoveredOrderRows: 1,
        finalOrderRows: 1,
      }),
    );
  } finally {
    await startPostgres();
    await expect.poll(async () => (await getPostgresStatus()).Health).toBe('healthy');
    await queryOrderDatabase(
      'DELETE FROM orders WHERE idempotency_key = ANY($1::text[])',
      [[initialIdempotencyKey, outageIdempotencyKey]],
    );
    expect(await countOrders(initialIdempotencyKey)).toBe(0);
    expect(await countOrders(outageIdempotencyKey)).toBe(0);
    await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');
    await serviceProcess.stop();
    await expect.poll(() => isOrderPortReachable()).toBe(false);
    await expect.poll(() => isPortReachable(3002)).toBe(false);
    await expect.poll(() => isPortReachable(3003)).toBe(false);
  }
});
