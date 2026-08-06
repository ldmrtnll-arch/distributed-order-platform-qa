import { createHash, randomUUID } from 'node:crypto';

import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';

import { queryInventoryDatabase } from '../../support/database.js';

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

interface ReservationDatabaseRow {
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

interface ProductDatabaseRow {
  totalQuantity: number;
  reservedQuantity: number;
}

const reservationFields = [
  'createdAt',
  'orderId',
  'quantity',
  'reservationId',
  'sku',
  'status',
];
const releasedReservationFields = [
  'orderId',
  'quantity',
  'releasedAt',
  'reservationId',
  'sku',
  'status',
];

async function readReservationRow(
  reservationId: string,
): Promise<ReservationDatabaseRow> {
  const rows = await queryInventoryDatabase<ReservationDatabaseRow>(
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
    throw new Error('Expected one persisted inventory reservation.');
  }
  return row;
}

async function readProductRow(sku: string): Promise<ProductDatabaseRow> {
  const rows = await queryInventoryDatabase<ProductDatabaseRow>(
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
    throw new Error('Expected one persisted inventory product.');
  }
  return row;
}

async function createReservation(
  request: APIRequestContext,
  sku: string,
  quantity: number,
): Promise<ReservationResponse> {
  const orderId = randomUUID();
  const response = await request.post('/reservations', {
    headers: {
      'Idempotency-Key': `reservation-create-${randomUUID()}`,
      'X-Correlation-Id': `correlation-${randomUUID()}`,
    },
    data: { orderId, sku, quantity },
  });

  expect(response.status()).toBe(201);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  expect(response.headers()).not.toHaveProperty('idempotent-replay');
  const body = (await response.json()) as ReservationResponse;
  expect(Object.keys(body).sort()).toEqual(reservationFields);
  expect(body).toEqual({
    reservationId: body.reservationId,
    orderId,
    sku,
    quantity,
    status: 'RESERVED',
    createdAt: body.createdAt,
  });
  expect(body.reservationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
  return body;
}

async function releaseReservation(
  request: APIRequestContext,
  reservationId: string,
  idempotencyKey: string,
): Promise<{ response: APIResponse; body: ReleasedReservationResponse }> {
  const response = await request.post(
    `/reservations/${reservationId}/release`,
    {
      headers: {
        'Idempotency-Key': idempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
    },
  );

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  const body = (await response.json()) as ReleasedReservationResponse;
  expect(Object.keys(body).sort()).toEqual(releasedReservationFields);
  expect(body.status).toBe('RELEASED');
  expect(Number.isNaN(Date.parse(body.releasedAt))).toBe(false);
  expect(body).not.toHaveProperty('createdAt');
  expect(body).not.toHaveProperty('idempotencyKey');
  expect(body).not.toHaveProperty('fingerprint');
  return { response, body };
}

function createReleaseFingerprint(reservationId: string): string {
  return createHash('sha256')
    .update(reservationId.toLowerCase())
    .digest('hex');
}

function expectProductState(
  product: ProductDatabaseRow,
  reservedQuantity: number,
): void {
  expect(product).toEqual({ totalQuantity: 10, reservedQuantity });
  expect(product.reservedQuantity).toBeGreaterThanOrEqual(0);
  expect(product.totalQuantity - product.reservedQuantity).toBe(
    10 - reservedQuantity,
  );
  expect(product.totalQuantity - product.reservedQuantity).toBeLessThanOrEqual(
    product.totalQuantity,
  );
}

test.describe('reservation release database consistency', () => {
  test('persists a released reservation and restores inventory consistently', async ({
    request,
  }) => {
    const sku = 'RESERVATION-RELEASE-DB-PERSISTENCE';
    const inventoryResponse = await request.get(`/inventory/${sku}`);
    expect(inventoryResponse.status()).toBe(200);
    expect(await inventoryResponse.json()).toMatchObject({
      totalQuantity: 10,
      reservedQuantity: 0,
      availableQuantity: 10,
    });

    const reservation = await createReservation(request, sku, 4);
    const reservedRow = await readReservationRow(reservation.reservationId);
    expect(reservedRow).toMatchObject({
      reservationId: reservation.reservationId,
      orderId: reservation.orderId,
      sku,
      quantity: 4,
      status: 'RESERVED',
      releaseIdempotencyKey: null,
      releaseRequestFingerprint: null,
      releasedAt: null,
    });
    expect(Number.isNaN(reservedRow.createdAt.getTime())).toBe(false);
    const originalCreatedAt = reservedRow.createdAt.getTime();
    expectProductState(await readProductRow(sku), 4);

    const releaseKey = `reservation-release-${randomUUID()}`;
    const released = await releaseReservation(
      request,
      reservation.reservationId,
      releaseKey,
    );
    expect(released.response.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    expect(released.body).toEqual({
      reservationId: reservation.reservationId,
      orderId: reservation.orderId,
      sku,
      quantity: 4,
      status: 'RELEASED',
      releasedAt: released.body.releasedAt,
    });

    const releasedRow = await readReservationRow(reservation.reservationId);
    const expectedFingerprint = createReleaseFingerprint(
      reservation.reservationId,
    );
    expect(releasedRow).toMatchObject({
      reservationId: reservation.reservationId,
      orderId: reservation.orderId,
      sku,
      quantity: 4,
      status: 'RELEASED',
      releaseIdempotencyKey: releaseKey,
      releaseRequestFingerprint: expectedFingerprint,
    });
    expect(releasedRow.releaseRequestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(releasedRow.releasedAt).not.toBeNull();
    expect(releasedRow.releasedAt?.getTime()).toBe(
      Date.parse(released.body.releasedAt),
    );
    expect(releasedRow.createdAt.getTime()).toBe(originalCreatedAt);
    expectProductState(await readProductRow(sku), 0);
  });

  test('preserves the persisted release state during an idempotent replay', async ({
    request,
  }) => {
    const sku = 'RESERVATION-RELEASE-DB-REPLAY';
    const reservation = await createReservation(request, sku, 3);
    expectProductState(await readProductRow(sku), 3);

    const releaseKey = `reservation-release-${randomUUID()}`;
    const released = await releaseReservation(
      request,
      reservation.reservationId,
      releaseKey,
    );
    expect(released.response.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    const reservationBeforeReplay = await readReservationRow(
      reservation.reservationId,
    );
    const productBeforeReplay = await readProductRow(sku);
    expect(reservationBeforeReplay.status).toBe('RELEASED');
    expect(reservationBeforeReplay.releaseIdempotencyKey).toBe(releaseKey);
    expect(reservationBeforeReplay.releaseRequestFingerprint).toBe(
      createReleaseFingerprint(reservation.reservationId),
    );
    expectProductState(productBeforeReplay, 0);

    const replay = await releaseReservation(
      request,
      reservation.reservationId,
      releaseKey,
    );
    expect(replay.response.headers()['idempotent-replay']).toBe('true');
    expect(replay.body).toEqual(released.body);
    expect(replay.body.releasedAt).toBe(released.body.releasedAt);

    const reservationAfterReplay = await readReservationRow(
      reservation.reservationId,
    );
    const productAfterReplay = await readProductRow(sku);
    expect(reservationAfterReplay).toEqual(reservationBeforeReplay);
    expect(reservationAfterReplay.releasedAt?.getTime()).toBe(
      reservationBeforeReplay.releasedAt?.getTime(),
    );
    expect(productAfterReplay).toEqual(productBeforeReplay);
    expectProductState(productAfterReplay, 0);
  });

  test('keeps the conflicting reservation unchanged in the database', async ({
    request,
  }) => {
    const skuA = 'RESERVATION-RELEASE-DB-CONFLICT-A';
    const skuB = 'RESERVATION-RELEASE-DB-CONFLICT-B';
    const reservationA = await createReservation(request, skuA, 2);
    const reservationB = await createReservation(request, skuB, 3);
    expectProductState(await readProductRow(skuA), 2);
    expectProductState(await readProductRow(skuB), 3);

    const releaseKey = `reservation-release-${randomUUID()}`;
    const releasedA = await releaseReservation(
      request,
      reservationA.reservationId,
      releaseKey,
    );
    expect(releasedA.response.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    const conflictResponse = await request.post(
      `/reservations/${reservationB.reservationId}/release`,
      {
        headers: {
          'Idempotency-Key': releaseKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
      },
    );
    expect(conflictResponse.status()).toBe(409);
    expect(conflictResponse.headers()['content-type']).toMatch(
      /^application\/json(?:;|$)/,
    );
    expect(conflictResponse.headers()).not.toHaveProperty('x-powered-by');
    expect(conflictResponse.headers()).not.toHaveProperty('idempotent-replay');
    expect(await conflictResponse.json()).toEqual({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      message: 'The idempotency key was already used with a different request.',
    });

    const releasedRowA = await readReservationRow(reservationA.reservationId);
    const reservedRowB = await readReservationRow(reservationB.reservationId);
    expect(releasedRowA).toMatchObject({
      status: 'RELEASED',
      releaseIdempotencyKey: releaseKey,
      releaseRequestFingerprint: createReleaseFingerprint(
        reservationA.reservationId,
      ),
    });
    expect(releasedRowA.releasedAt).not.toBeNull();
    expect(reservedRowB).toMatchObject({
      reservationId: reservationB.reservationId,
      orderId: reservationB.orderId,
      sku: skuB,
      quantity: 3,
      status: 'RESERVED',
      releaseIdempotencyKey: null,
      releaseRequestFingerprint: null,
      releasedAt: null,
    });
    const productA = await readProductRow(skuA);
    const productB = await readProductRow(skuB);
    expectProductState(productA, 0);
    expectProductState(productB, 3);

    const replayA = await releaseReservation(
      request,
      reservationA.reservationId,
      releaseKey,
    );
    expect(replayA.response.headers()['idempotent-replay']).toBe('true');
    expect(replayA.body).toEqual(releasedA.body);
    expect(await readReservationRow(reservationA.reservationId)).toEqual(
      releasedRowA,
    );
    expect(await readReservationRow(reservationB.reservationId)).toEqual(
      reservedRowB,
    );
    expect(await readProductRow(skuA)).toEqual(productA);
    expect(await readProductRow(skuB)).toEqual(productB);
  });
});
