import { randomUUID } from 'node:crypto';

import { expect, test, type APIResponse } from '@playwright/test';

import {
  getPostgresStatus,
  startPostgres,
  stopPostgres,
} from '../../support/docker-compose.js';
import {
  isPortReachable,
  startInventoryService,
} from '../../support/inventory-service-process.js';

interface ServiceLog {
  correlationId?: string;
  errorCode?: string;
  errorMessage?: string;
  errorName?: string;
  level?: string;
  operation?: string;
  orderId?: string;
  service?: string;
  sku?: string;
}

const databaseUnavailableBody = {
  code: 'INVENTORY_DATABASE_UNAVAILABLE',
  message: 'Inventory data is temporarily unavailable.',
};

async function expectDatabaseUnavailable(
  response: APIResponse,
): Promise<void> {
  expect(response.status()).toBe(503);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  await expect(response.json()).resolves.toEqual(databaseUnavailableBody);
}

function parseServiceLogs(rawLogs: string): ServiceLog[] {
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

test('returns 503 during a database outage and recovers without restarting', async ({
  request,
}) => {
  const sku = 'RESERVATION-RESILIENCE-001';

  await expect
    .poll(async () => (await getPostgresStatus()).Health)
    .toBe('healthy');

  const serviceProcess = startInventoryService();
  const initialPid = serviceProcess.pid;

  console.log(
    JSON.stringify({ phase: 'initial', pid: initialPid, isRunning: true }),
  );

  try {
    await expect.poll(() => isPortReachable(3002)).toBe(true);

    const initialHealthResponse = await request.get('/health');

    expect(initialHealthResponse.status()).toBe(200);
    await expect(initialHealthResponse.json()).resolves.toEqual({
      service: 'inventory-service',
      status: 'UP',
      dependencies: { database: 'UP' },
    });

    const initialInventoryResponse = await request.get(`/inventory/${sku}`);

    expect(initialInventoryResponse.status()).toBe(200);
    await expect(initialInventoryResponse.json()).resolves.toMatchObject({
      sku,
      totalQuantity: 5,
      reservedQuantity: 0,
      availableQuantity: 5,
    });

    await stopPostgres();
    await expect
      .poll(async () => (await getPostgresStatus()).State.toLowerCase())
      .toMatch(/exited|stopped/u);
    console.log(
      JSON.stringify({
        phase: 'database-outage',
        pid: serviceProcess.pid,
        isRunning: serviceProcess.isRunning(),
      }),
    );
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);

    const unavailableInventoryResponse = await request.get(
      `/inventory/${sku}`,
    );

    await expectDatabaseUnavailable(unavailableInventoryResponse);

    const failedOrderId = randomUUID();
    const failedCorrelationId = `correlation-${randomUUID()}`;
    const unavailableReservationResponse = await request.post(
      '/reservations',
      {
        headers: {
          'Idempotency-Key': `reservation-${randomUUID()}`,
          'X-Correlation-Id': failedCorrelationId,
        },
        data: { orderId: failedOrderId, sku, quantity: 1 },
      },
    );

    expect(unavailableReservationResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    await expectDatabaseUnavailable(unavailableReservationResponse);
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);

    await expect
      .poll(() => {
        const logs = parseServiceLogs(serviceProcess.logs());

        return {
          inventory: logs.some(
            (entry) => entry.operation === 'get-inventory-item',
          ),
          reservation: logs.some(
            (entry) => entry.operation === 'create-inventory-reservation',
          ),
        };
      })
      .toEqual({ inventory: true, reservation: true });

    const logs = parseServiceLogs(serviceProcess.logs());
    const inventoryError = logs.find(
      (entry) => entry.operation === 'get-inventory-item',
    );
    const reservationError = logs.find(
      (entry) => entry.operation === 'create-inventory-reservation',
    );

    expect(inventoryError).toMatchObject({
      level: 'error',
      service: 'inventory-service',
      operation: 'get-inventory-item',
      sku,
    });
    expect(inventoryError?.errorMessage).toEqual(expect.any(String));
    expect(inventoryError?.errorMessage?.trim()).not.toBe('');
    expect(reservationError).toMatchObject({
      level: 'error',
      service: 'inventory-service',
      operation: 'create-inventory-reservation',
      sku,
      orderId: failedOrderId,
      correlationId: failedCorrelationId,
    });
    expect(reservationError?.errorMessage).toEqual(expect.any(String));
    expect(reservationError?.errorMessage?.trim()).not.toBe('');

    const serializedErrorLogs = JSON.stringify([
      inventoryError,
      reservationError,
    ]);

    expect(serializedErrorLogs).not.toMatch(
      /password|postgres(?:ql)?:\/\/[^\s"]+@|connectionstring|stack|\.env|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|[a-z]:\\\\|\/services\//i,
    );

    await startPostgres();
    await expect
      .poll(async () => (await getPostgresStatus()).Health)
      .toBe('healthy');
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);

    await expect
      .poll(async () => {
        try {
          const response = await request.get('/health');

          if (response.status() !== 200) return null;
          return response.json();
        } catch {
          return null;
        }
      })
      .toEqual({
        service: 'inventory-service',
        status: 'UP',
        dependencies: { database: 'UP' },
      });

    const recoveredInventoryResponse = await request.get(`/inventory/${sku}`);

    expect(recoveredInventoryResponse.status()).toBe(200);
    await expect(recoveredInventoryResponse.json()).resolves.toMatchObject({
      sku,
      totalQuantity: 5,
      reservedQuantity: 0,
      availableQuantity: 5,
    });

    const recoveredOrderId = randomUUID();
    const recoveredReservationResponse = await request.post('/reservations', {
      headers: {
        'Idempotency-Key': `reservation-${randomUUID()}`,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: { orderId: recoveredOrderId, sku, quantity: 1 },
    });

    expect(recoveredReservationResponse.status()).toBe(201);
    expect(recoveredReservationResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    await expect(recoveredReservationResponse.json()).resolves.toMatchObject({
      orderId: recoveredOrderId,
      sku,
      quantity: 1,
      status: 'RESERVED',
    });

    const finalInventoryResponse = await request.get(`/inventory/${sku}`);

    expect(finalInventoryResponse.status()).toBe(200);
    await expect(finalInventoryResponse.json()).resolves.toMatchObject({
      sku,
      totalQuantity: 5,
      reservedQuantity: 1,
      availableQuantity: 4,
    });
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);
  } finally {
    await startPostgres();
    await expect
      .poll(async () => (await getPostgresStatus()).Health)
      .toBe('healthy');
    await serviceProcess.stop();
    await expect.poll(() => isPortReachable(3002)).toBe(false);
  }
});
