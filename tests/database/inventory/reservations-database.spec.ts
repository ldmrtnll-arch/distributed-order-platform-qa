import { randomUUID } from 'node:crypto';

import { expect, test, type APIResponse } from '@playwright/test';

import { queryInventoryDatabase } from '../../support/database.js';

interface ReservationResponse {
  reservationId: string;
  orderId: string;
  sku: string;
  quantity: number;
  status: string;
  createdAt: string;
}

interface ReservationRow {
  reservation_id: string;
  order_id: string;
  sku: string;
  quantity: number;
  status: string;
  idempotency_key: string;
  request_fingerprint: string;
  created_at: Date;
  updated_at: Date;
}

interface ProductRow {
  total_quantity: number;
  reserved_quantity: number;
}

interface ReservedQuantityRow {
  reserved_quantity: number;
}

interface ReservationAggregateRow {
  row_count: number;
  reservation_count: number;
  total_quantity: number;
}

interface CountRow {
  count: number;
}

const reservationResponseFields = [
  'createdAt',
  'orderId',
  'quantity',
  'reservationId',
  'sku',
  'status',
];

async function readReservation(
  response: APIResponse,
  expectedStatus: number,
): Promise<ReservationResponse> {
  expect(response.status()).toBe(expectedStatus);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');

  const body = (await response.json()) as ReservationResponse;

  expect(Object.keys(body).sort()).toEqual(reservationResponseFields);
  expect(typeof body.reservationId).toBe('string');
  expect(typeof body.orderId).toBe('string');
  expect(typeof body.sku).toBe('string');
  expect(typeof body.quantity).toBe('number');
  expect(typeof body.status).toBe('string');
  expect(typeof body.createdAt).toBe('string');
  expect(body.reservationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);

  return body;
}

test.describe('POST /reservations database consistency', () => {
  test('persists a successful reservation consistently in the database', async ({
    request,
  }) => {
    const sku = 'RESERVATION-DB-CREATE-001';
    const orderId = randomUUID();
    const idempotencyKey = `reservation-${randomUUID()}`;
    const response = await request.post('/reservations', {
      headers: { 'Idempotency-Key': idempotencyKey },
      data: { orderId, sku, quantity: 2 },
    });

    expect(response.headers()).not.toHaveProperty('idempotent-replay');
    const reservation = await readReservation(response, 201);

    expect(reservation).toMatchObject({
      orderId,
      sku,
      quantity: 2,
      status: 'RESERVED',
    });

    const reservationRows = await queryInventoryDatabase<ReservationRow>(
      `
        SELECT
          reservation_id,
          order_id,
          sku,
          quantity,
          status,
          idempotency_key,
          request_fingerprint,
          created_at,
          updated_at
        FROM inventory_reservations
        WHERE idempotency_key = $1
      `,
      [idempotencyKey],
    );

    expect(reservationRows).toHaveLength(1);
    const persistedReservation = reservationRows[0];

    expect(persistedReservation).toBeDefined();
    expect(persistedReservation).toMatchObject({
      reservation_id: reservation.reservationId,
      order_id: orderId,
      sku,
      quantity: 2,
      status: 'RESERVED',
      idempotency_key: idempotencyKey,
    });
    expect(persistedReservation?.request_fingerprint).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(
      Number.isNaN(Date.parse(String(persistedReservation?.created_at))),
    ).toBe(false);
    expect(
      Number.isNaN(Date.parse(String(persistedReservation?.updated_at))),
    ).toBe(false);

    const productRows = await queryInventoryDatabase<ProductRow>(
      `
        SELECT total_quantity, reserved_quantity
        FROM products
        WHERE sku = $1
      `,
      [sku],
    );

    expect(productRows).toEqual([
      { total_quantity: 5, reserved_quantity: 2 },
    ]);
    expect(
      (productRows[0]?.total_quantity ?? 0) -
        (productRows[0]?.reserved_quantity ?? 0),
    ).toBe(3);

    const reservedQuantityRows =
      await queryInventoryDatabase<ReservedQuantityRow>(
        `
          SELECT COALESCE(SUM(quantity), 0)::integer AS reserved_quantity
          FROM inventory_reservations
          WHERE sku = $1 AND status = $2
        `,
        [sku, 'RESERVED'],
      );

    expect(reservedQuantityRows).toEqual([{ reserved_quantity: 2 }]);
    expect(reservedQuantityRows[0]?.reserved_quantity).toBe(
      productRows[0]?.reserved_quantity,
    );
  });

  test('does not persist duplicate rows during an idempotent replay', async ({
    request,
  }) => {
    const sku = 'RESERVATION-DB-IDEMP-001';
    const orderId = randomUUID();
    const idempotencyKey = `reservation-${randomUUID()}`;
    const requestBody = { orderId, sku, quantity: 1 };
    const headers = { 'Idempotency-Key': idempotencyKey };

    const creationResponse = await request.post('/reservations', {
      headers,
      data: requestBody,
    });
    const createdReservation = await readReservation(creationResponse, 201);

    const replayResponse = await request.post('/reservations', {
      headers,
      data: requestBody,
    });

    expect(replayResponse.headers()['idempotent-replay']).toBe('true');
    const replayedReservation = await readReservation(replayResponse, 200);

    expect(replayedReservation).toEqual(createdReservation);

    const aggregateRows =
      await queryInventoryDatabase<ReservationAggregateRow>(
        `
          SELECT
            COUNT(*)::integer AS row_count,
            COUNT(DISTINCT reservation_id)::integer AS reservation_count,
            COALESCE(SUM(quantity), 0)::integer AS total_quantity
          FROM inventory_reservations
          WHERE idempotency_key = $1
        `,
        [idempotencyKey],
      );

    expect(aggregateRows).toEqual([
      { row_count: 1, reservation_count: 1, total_quantity: 1 },
    ]);

    const productRows = await queryInventoryDatabase<ProductRow>(
      `
        SELECT total_quantity, reserved_quantity
        FROM products
        WHERE sku = $1
      `,
      [sku],
    );

    expect(productRows).toEqual([
      { total_quantity: 5, reserved_quantity: 1 },
    ]);
    expect(
      (productRows[0]?.total_quantity ?? 0) -
        (productRows[0]?.reserved_quantity ?? 0),
    ).toBe(4);
  });

  test('does not persist a reservation or change stock after insufficient inventory', async ({
    request,
  }) => {
    const sku = 'RESERVATION-DB-FAILURE-001';
    const initialProductRows = await queryInventoryDatabase<ProductRow>(
      `
        SELECT total_quantity, reserved_quantity
        FROM products
        WHERE sku = $1
      `,
      [sku],
    );

    expect(initialProductRows).toEqual([
      { total_quantity: 2, reserved_quantity: 0 },
    ]);
    expect(
      (initialProductRows[0]?.total_quantity ?? 0) -
        (initialProductRows[0]?.reserved_quantity ?? 0),
    ).toBe(2);

    const orderId = randomUUID();
    const idempotencyKey = `reservation-${randomUUID()}`;
    const response = await request.post('/reservations', {
      headers: { 'Idempotency-Key': idempotencyKey },
      data: { orderId, sku, quantity: 3 },
    });

    expect(response.status()).toBe(409);
    expect(response.headers()['content-type']).toMatch(
      /^application\/json(?:;|$)/,
    );
    expect(response.headers()).not.toHaveProperty('x-powered-by');
    expect(response.headers()).not.toHaveProperty('idempotent-replay');
    await expect(response.json()).resolves.toEqual({
      code: 'INVENTORY_INSUFFICIENT_STOCK',
      message: 'Insufficient inventory for the requested quantity.',
      details: { sku, requestedQuantity: 3, availableQuantity: 2 },
    });

    const rowsByKey = await queryInventoryDatabase<CountRow>(
      `
        SELECT COUNT(*)::integer AS count
        FROM inventory_reservations
        WHERE idempotency_key = $1
      `,
      [idempotencyKey],
    );
    const rowsByOrder = await queryInventoryDatabase<CountRow>(
      `
        SELECT COUNT(*)::integer AS count
        FROM inventory_reservations
        WHERE order_id = $1
      `,
      [orderId],
    );

    expect(rowsByKey).toEqual([{ count: 0 }]);
    expect(rowsByOrder).toEqual([{ count: 0 }]);

    const finalProductRows = await queryInventoryDatabase<ProductRow>(
      `
        SELECT total_quantity, reserved_quantity
        FROM products
        WHERE sku = $1
      `,
      [sku],
    );

    expect(finalProductRows).toEqual([
      { total_quantity: 2, reserved_quantity: 0 },
    ]);
    expect(
      (finalProductRows[0]?.total_quantity ?? 0) -
        (finalProductRows[0]?.reserved_quantity ?? 0),
    ).toBe(2);
  });
});
