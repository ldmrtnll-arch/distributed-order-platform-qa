import { randomUUID } from 'node:crypto';

import { expect, test, type APIResponse } from '@playwright/test';

interface InventoryItemResponse {
  sku: string;
  name: string;
  totalQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
}

interface ReservationResponse {
  reservationId: string;
  orderId: string;
  sku: string;
  quantity: number;
  status: string;
  createdAt: string;
}

const reservationResponseFields = [
  'createdAt',
  'orderId',
  'quantity',
  'reservationId',
  'sku',
  'status',
];

async function readInventoryItem(
  response: APIResponse,
): Promise<InventoryItemResponse> {
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );

  const body = (await response.json()) as InventoryItemResponse;

  expect(typeof body.sku).toBe('string');
  expect(typeof body.name).toBe('string');
  expect(typeof body.totalQuantity).toBe('number');
  expect(typeof body.reservedQuantity).toBe('number');
  expect(typeof body.availableQuantity).toBe('number');

  expect(body.availableQuantity).toBe(
    body.totalQuantity - body.reservedQuantity,
  );

  return body;
}

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

test.describe('POST /reservations', () => {
  test('creates a reservation and replays the same request idempotently', async ({
    request,
  }) => {
    const orderId = randomUUID();
    const idempotencyKey = `reservation-${randomUUID()}`;

    const requestBody = {
      orderId,
      sku: ' reservation-idemp-001 ',
      quantity: 1,
    };

    const inventoryBeforeResponse = await request.get(
      '/inventory/RESERVATION-IDEMP-001',
    );
    const inventoryBefore = await readInventoryItem(
      inventoryBeforeResponse,
    );

    expect(inventoryBefore).toMatchObject({
      sku: 'RESERVATION-IDEMP-001',
      totalQuantity: 5,
      reservedQuantity: 0,
      availableQuantity: 5,
    });

    const creationResponse = await request.post('/reservations', {
      headers: {
        'Idempotency-Key': idempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: requestBody,
    });

    expect(creationResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );

    const createdReservation = await readReservation(
      creationResponse,
      201,
    );

    expect(createdReservation).toMatchObject({
      orderId,
      sku: 'RESERVATION-IDEMP-001',
      quantity: 1,
      status: 'RESERVED',
    });

    const inventoryAfterCreationResponse = await request.get(
      '/inventory/RESERVATION-IDEMP-001',
    );
    const inventoryAfterCreation = await readInventoryItem(
      inventoryAfterCreationResponse,
    );

    expect(inventoryAfterCreation).toMatchObject({
      totalQuantity: 5,
      reservedQuantity: 1,
      availableQuantity: 4,
    });

    const replayResponse = await request.post('/reservations', {
      headers: {
        'Idempotency-Key': idempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: requestBody,
    });

    expect(replayResponse.headers()['idempotent-replay']).toBe('true');

    const replayedReservation = await readReservation(
      replayResponse,
      200,
    );

    expect(replayedReservation).toEqual(createdReservation);

    const inventoryAfterReplayResponse = await request.get(
      '/inventory/RESERVATION-IDEMP-001',
    );
    const inventoryAfterReplay = await readInventoryItem(
      inventoryAfterReplayResponse,
    );

    expect(inventoryAfterReplay).toMatchObject({
      totalQuantity: 5,
      reservedQuantity: 1,
      availableQuantity: 4,
    });
  });

  test('rejects reuse of an idempotency key with different request data', async ({
    request,
  }) => {
    const orderId = randomUUID();
    const idempotencyKey = `reservation-${randomUUID()}`;
    const requestBody = {
      orderId,
      sku: 'RESERVATION-CONFLICT-001',
      quantity: 1,
    };

    const creationResponse = await request.post('/reservations', {
      headers: {
        'Idempotency-Key': idempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: requestBody,
    });

    expect(creationResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );

    const createdReservation = await readReservation(
      creationResponse,
      201,
    );

    expect(createdReservation).toMatchObject({
      orderId,
      sku: 'RESERVATION-CONFLICT-001',
      quantity: 1,
      status: 'RESERVED',
    });

    const conflictResponse = await request.post('/reservations', {
      headers: {
        'Idempotency-Key': idempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: {
        ...requestBody,
        quantity: 2,
      },
    });

    expect(conflictResponse.status()).toBe(409);
    expect(conflictResponse.headers()['content-type']).toMatch(
      /^application\/json(?:;|$)/,
    );
    expect(conflictResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    expect(conflictResponse.headers()).not.toHaveProperty('x-powered-by');
    await expect(conflictResponse.json()).resolves.toEqual({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      message:
        'The idempotency key was already used with a different request.',
    });

    const inventoryAfterConflictResponse = await request.get(
      '/inventory/RESERVATION-CONFLICT-001',
    );
    const inventoryAfterConflict = await readInventoryItem(
      inventoryAfterConflictResponse,
    );

    expect(inventoryAfterConflict).toMatchObject({
      totalQuantity: 5,
      reservedQuantity: 1,
      availableQuantity: 4,
    });

    const replayResponse = await request.post('/reservations', {
      headers: {
        'Idempotency-Key': idempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: requestBody,
    });

    expect(replayResponse.headers()['idempotent-replay']).toBe('true');

    const replayedReservation = await readReservation(
      replayResponse,
      200,
    );

    expect(replayedReservation).toEqual(createdReservation);

    const inventoryAfterReplayResponse = await request.get(
      '/inventory/RESERVATION-CONFLICT-001',
    );
    const inventoryAfterReplay = await readInventoryItem(
      inventoryAfterReplayResponse,
    );

    expect(inventoryAfterReplay).toMatchObject({
      totalQuantity: 5,
      reservedQuantity: 1,
      availableQuantity: 4,
    });
  });

  test('returns not found without changing inventory for an unknown SKU', async ({
    request,
  }) => {
    const orderId = randomUUID();
    const idempotencyKey = `reservation-${randomUUID()}`;

    const reservationResponse = await request.post('/reservations', {
      headers: {
        'Idempotency-Key': idempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: {
        orderId,
        sku: ' unknown-reservation-001 ',
        quantity: 1,
      },
    });

    expect(reservationResponse.status()).toBe(404);
    expect(reservationResponse.headers()['content-type']).toMatch(
      /^application\/json(?:;|$)/,
    );
    expect(reservationResponse.headers()).not.toHaveProperty(
      'x-powered-by',
    );
    expect(reservationResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    await expect(reservationResponse.json()).resolves.toEqual({
      code: 'INVENTORY_ITEM_NOT_FOUND',
      message: 'Inventory item not found.',
      details: {
        sku: 'UNKNOWN-RESERVATION-001',
      },
    });

    const inventoryResponse = await request.get(
      '/inventory/UNKNOWN-RESERVATION-001',
    );

    expect(inventoryResponse.status()).toBe(404);
    expect(inventoryResponse.headers()['content-type']).toMatch(
      /^application\/json(?:;|$)/,
    );
    expect(inventoryResponse.headers()).not.toHaveProperty('x-powered-by');
    await expect(inventoryResponse.json()).resolves.toEqual({
      code: 'INVENTORY_ITEM_NOT_FOUND',
      message: 'Inventory item not found.',
      details: {
        sku: 'UNKNOWN-RESERVATION-001',
      },
    });
  });

  test('rejects a reservation when available stock is insufficient', async ({
    request,
  }) => {
    const inventoryBeforeResponse = await request.get(
      '/inventory/RESERVATION-INSUFFICIENT-001',
    );
    const inventoryBefore = await readInventoryItem(
      inventoryBeforeResponse,
    );

    expect(inventoryBefore).toMatchObject({
      sku: 'RESERVATION-INSUFFICIENT-001',
      totalQuantity: 2,
      reservedQuantity: 0,
      availableQuantity: 2,
    });

    const orderId = randomUUID();
    const idempotencyKey = `reservation-${randomUUID()}`;
    const reservationResponse = await request.post('/reservations', {
      headers: {
        'Idempotency-Key': idempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: {
        orderId,
        sku: 'RESERVATION-INSUFFICIENT-001',
        quantity: 3,
      },
    });

    expect(reservationResponse.status()).toBe(409);
    expect(reservationResponse.headers()['content-type']).toMatch(
      /^application\/json(?:;|$)/,
    );
    expect(reservationResponse.headers()).not.toHaveProperty(
      'x-powered-by',
    );
    expect(reservationResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    await expect(reservationResponse.json()).resolves.toEqual({
      code: 'INVENTORY_INSUFFICIENT_STOCK',
      message: 'Insufficient inventory for the requested quantity.',
      details: {
        sku: 'RESERVATION-INSUFFICIENT-001',
        requestedQuantity: 3,
        availableQuantity: 2,
      },
    });

    const inventoryAfterResponse = await request.get(
      '/inventory/RESERVATION-INSUFFICIENT-001',
    );
    const inventoryAfter = await readInventoryItem(
      inventoryAfterResponse,
    );

    expect(inventoryAfter).toMatchObject({
      sku: 'RESERVATION-INSUFFICIENT-001',
      totalQuantity: 2,
      reservedQuantity: 0,
      availableQuantity: 2,
    });
  });
});
