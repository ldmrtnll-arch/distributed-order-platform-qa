import { createHash, randomUUID } from 'node:crypto';

import { expect, test, type APIResponse } from '@playwright/test';

import { queryInventoryDatabase } from '../../support/database.js';
import {
  getPostgresStatus,
  getRabbitMqStatus,
  startPostgres,
  stopPostgres,
} from '../../support/docker-compose.js';
import {
  isPortReachable,
  startInventoryService,
} from '../../support/inventory-service-process.js';

interface ReservationResponse {
  reservationId: string;
  orderId: string;
  sku: string;
  quantity: number;
  status: 'RESERVED';
  createdAt: string;
}

interface ReleasedReservationResponse {
  reservationId: string;
  orderId: string;
  sku: string;
  quantity: number;
  status: 'RELEASED';
  releasedAt: string;
}

interface ReservationRow {
  reservationId: string;
  orderId: string;
  sku: string;
  quantity: number;
  status: 'RESERVED' | 'RELEASED';
  releaseIdempotencyKey: string | null;
  releaseRequestFingerprint: string | null;
  releasedAt: Date | null;
  createdAt: Date;
}

interface ProductRow {
  totalQuantity: number;
  reservedQuantity: number;
}

interface ServiceLog {
  correlationId?: string;
  errorMessage?: string;
  level?: string;
  operation?: string;
  reservationId?: string;
  service?: string;
}

const sku = 'RESERVATION-RELEASE-RESILIENCE-001';
const productName = 'Reservation Release Database Resilience Test Product';
const reservationFields = [
  'createdAt',
  'orderId',
  'quantity',
  'reservationId',
  'sku',
  'status',
];
const releaseFields = [
  'orderId',
  'quantity',
  'releasedAt',
  'reservationId',
  'sku',
  'status',
];

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

async function readReservationRow(reservationId: string): Promise<ReservationRow> {
  const rows = await queryInventoryDatabase<ReservationRow>(
    `
      SELECT
        reservation_id AS "reservationId",
        order_id AS "orderId",
        sku,
        quantity,
        status,
        release_idempotency_key AS "releaseIdempotencyKey",
        release_request_fingerprint AS "releaseRequestFingerprint",
        released_at AS "releasedAt",
        created_at AS "createdAt"
      FROM inventory_reservations
      WHERE reservation_id = $1
    `,
    [reservationId],
  );
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error('Expected the resilience reservation to exist.');
  }
  return row;
}

async function readProductRow(): Promise<ProductRow> {
  const rows = await queryInventoryDatabase<ProductRow>(
    `
      SELECT
        total_quantity AS "totalQuantity",
        reserved_quantity AS "reservedQuantity"
      FROM products
      WHERE sku = $1
    `,
    [sku],
  );
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error('Expected the resilience product to exist.');
  }
  return row;
}

function expectProduct(row: ProductRow, reservedQuantity: number): void {
  expect(row).toEqual({ totalQuantity: 10, reservedQuantity });
  expect(row.totalQuantity - row.reservedQuantity).toBe(10 - reservedQuantity);
}

function releaseFingerprint(reservationId: string): string {
  return createHash('sha256')
    .update(reservationId.toLowerCase())
    .digest('hex');
}

async function expectSafeDatabaseUnavailable(
  response: APIResponse,
  sensitiveValues: string[],
): Promise<void> {
  expect(response.status()).toBe(503);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  expect(response.headers()).not.toHaveProperty('idempotent-replay');
  const body = (await response.json()) as unknown;
  expect(body).toEqual({
    code: 'INVENTORY_DATABASE_UNAVAILABLE',
    message: 'Inventory data is temporarily unavailable.',
  });
  const serializedBody = JSON.stringify(body);
  for (const value of sensitiveValues) {
    expect(serializedBody).not.toContain(value);
  }
  expect(serializedBody).not.toMatch(
    /fingerprint|password|postgres(?:ql)?:\/\/[^\s"]+@|connectionstring|stack|\.env|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|[a-z]:\\|\/services\/|node_modules/i,
  );
}

test('returns 503 for a release during a database outage and completes it after recovery without restarting', async ({
  request,
}) => {
  await expect.poll(async () => (await getPostgresStatus()).Health).toBe('healthy');
  await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');

  const serviceProcess = startInventoryService();
  const initialPid = serviceProcess.pid;
  let reservationId: string | undefined;

  console.log(JSON.stringify({ phase: 'initial', pid: initialPid, isRunning: true }));

  try {
    await expect.poll(() => isPortReachable(3002)).toBe(true);
    const initialHealth = await request.get('/health');
    expect(initialHealth.status()).toBe(200);
    await expect(initialHealth.json()).resolves.toEqual({
      service: 'inventory-service',
      status: 'UP',
      dependencies: { database: 'UP' },
    });

    const initialInventory = await request.get(`/inventory/${sku}`);
    expect(initialInventory.status()).toBe(200);
    await expect(initialInventory.json()).resolves.toEqual({
      sku,
      name: productName,
      totalQuantity: 10,
      reservedQuantity: 0,
      availableQuantity: 10,
    });

    const orderId = randomUUID();
    const createResponse = await request.post('/reservations', {
      headers: {
        'Idempotency-Key': `reservation-create-${randomUUID()}`,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: { orderId, sku: ` ${sku.toLowerCase()} `, quantity: 4 },
    });
    expect(createResponse.status()).toBe(201);
    expect(createResponse.headers()).not.toHaveProperty('x-powered-by');
    expect(createResponse.headers()).not.toHaveProperty('idempotent-replay');
    const reservation = (await createResponse.json()) as ReservationResponse;
    expect(Object.keys(reservation).sort()).toEqual(reservationFields);
    expect(reservation).toEqual({
      reservationId: reservation.reservationId,
      orderId,
      sku,
      quantity: 4,
      status: 'RESERVED',
      createdAt: reservation.createdAt,
    });
    expect(reservation.reservationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    reservationId = reservation.reservationId;

    const inventoryAfterReservation = await request.get(`/inventory/${sku}`);
    await expect(inventoryAfterReservation.json()).resolves.toMatchObject({
      totalQuantity: 10,
      reservedQuantity: 4,
      availableQuantity: 6,
    });
    const reservedRow = await readReservationRow(reservation.reservationId);
    expect(reservedRow).toMatchObject({
      reservationId: reservation.reservationId,
      orderId,
      sku,
      quantity: 4,
      status: 'RESERVED',
      releaseIdempotencyKey: null,
      releaseRequestFingerprint: null,
      releasedAt: null,
    });
    expectProduct(await readProductRow(), 4);

    const releaseKey = `reservation-release-${randomUUID()}`;
    const outageCorrelationId = `correlation-${randomUUID()}`;
    await stopPostgres();
    await expect
      .poll(async () => (await getPostgresStatus()).State.toLowerCase())
      .toMatch(/exited|stopped/u);
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);
    console.log(
      JSON.stringify({
        phase: 'database-outage',
        pid: serviceProcess.pid,
        isRunning: serviceProcess.isRunning(),
      }),
    );

    const degradedHealth = await request.get('/health');
    expect(degradedHealth.status()).toBe(503);
    await expect(degradedHealth.json()).resolves.toEqual({
      service: 'inventory-service',
      status: 'DEGRADED',
      dependencies: { database: 'DOWN' },
    });

    const unavailableRelease = await request.post(
      `/reservations/${reservation.reservationId}/release`,
      {
        headers: {
          'Idempotency-Key': releaseKey,
          'X-Correlation-Id': outageCorrelationId,
        },
      },
    );
    await expectSafeDatabaseUnavailable(unavailableRelease, [
      reservation.reservationId,
      orderId,
      sku,
      releaseKey,
    ]);
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);

    await expect
      .poll(() =>
        parseServiceLogs(serviceProcess.logs()).some(
          (entry) => entry.operation === 'release-inventory-reservation',
        ),
      )
      .toBe(true);
    const releaseError = parseServiceLogs(serviceProcess.logs()).find(
      (entry) => entry.operation === 'release-inventory-reservation',
    );
    expect(releaseError).toMatchObject({
      level: 'error',
      service: 'inventory-service',
      operation: 'release-inventory-reservation',
      reservationId: reservation.reservationId,
      correlationId: outageCorrelationId,
    });
    expect(releaseError?.errorMessage).toEqual(expect.any(String));
    expect(releaseError?.errorMessage?.trim()).not.toBe('');
    const serializedReleaseError = JSON.stringify(releaseError);
    expect(serializedReleaseError).not.toContain(releaseKey);
    expect(serializedReleaseError).not.toMatch(
      /fingerprint|password|postgres(?:ql)?:\/\/[^\s"]+@|connectionstring|stack|\.env|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|[a-z]:\\|\/services\/|node_modules|unexpected release body/i,
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
      .toEqual({
        service: 'inventory-service',
        status: 'UP',
        dependencies: { database: 'UP' },
      });
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);
    await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');

    expect(await readReservationRow(reservation.reservationId)).toEqual(reservedRow);
    expectProduct(await readProductRow(), 4);

    const recoveredRelease = await request.post(
      `/reservations/${reservation.reservationId}/release`,
      {
        headers: {
          'Idempotency-Key': releaseKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
      },
    );
    expect(recoveredRelease.status()).toBe(200);
    expect(recoveredRelease.headers()['content-type']).toMatch(
      /^application\/json(?:;|$)/,
    );
    expect(recoveredRelease.headers()).not.toHaveProperty('x-powered-by');
    expect(recoveredRelease.headers()).not.toHaveProperty('idempotent-replay');
    const released = (await recoveredRelease.json()) as ReleasedReservationResponse;
    expect(Object.keys(released).sort()).toEqual(releaseFields);
    expect(released).toEqual({
      reservationId: reservation.reservationId,
      orderId,
      sku,
      quantity: 4,
      status: 'RELEASED',
      releasedAt: released.releasedAt,
    });
    expect(Number.isNaN(Date.parse(released.releasedAt))).toBe(false);

    const releasedRow = await readReservationRow(reservation.reservationId);
    expect(releasedRow).toMatchObject({
      reservationId: reservation.reservationId,
      orderId,
      sku,
      quantity: 4,
      status: 'RELEASED',
      releaseIdempotencyKey: releaseKey,
      releaseRequestFingerprint: releaseFingerprint(reservation.reservationId),
    });
    expect(releasedRow.releaseRequestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(releasedRow.releasedAt?.getTime()).toBe(Date.parse(released.releasedAt));
    expect(releasedRow.createdAt.getTime()).toBe(reservedRow.createdAt.getTime());
    expectProduct(await readProductRow(), 0);

    const replayResponse = await request.post(
      `/reservations/${reservation.reservationId}/release`,
      {
        headers: {
          'Idempotency-Key': releaseKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
      },
    );
    expect(replayResponse.status()).toBe(200);
    expect(replayResponse.headers()['idempotent-replay']).toBe('true');
    expect(await replayResponse.json()).toEqual(released);
    expect(await readReservationRow(reservation.reservationId)).toEqual(releasedRow);
    expectProduct(await readProductRow(), 0);
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);
    const finalHealth = await request.get('/health');
    expect(finalHealth.status()).toBe(200);
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
    try {
      if (reservationId !== undefined) {
        await queryInventoryDatabase(
          'DELETE FROM inventory_reservations WHERE reservation_id = $1',
          [reservationId],
        );
      }
      await queryInventoryDatabase(
        'UPDATE products SET reserved_quantity = 0 WHERE sku = $1',
        [sku],
      );
      await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');
    } finally {
      await serviceProcess.stop();
      await expect.poll(() => isPortReachable(3002)).toBe(false);
    }
  }
});
