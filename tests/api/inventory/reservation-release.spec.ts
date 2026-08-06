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

interface ReleasedReservationResponse {
  reservationId: string;
  orderId: string;
  sku: string;
  quantity: number;
  status: string;
  releasedAt: string;
}

const sku = 'RESERVATION-RELEASE-IDEMP-001';
const inventoryFields = [
  'availableQuantity',
  'name',
  'reservedQuantity',
  'sku',
  'totalQuantity',
];
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

async function readInventoryItem(
  response: APIResponse,
): Promise<InventoryItemResponse> {
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');

  const body = (await response.json()) as InventoryItemResponse;

  expect(Object.keys(body).sort()).toEqual(inventoryFields);
  expect(body.availableQuantity).toBe(
    body.totalQuantity - body.reservedQuantity,
  );

  return body;
}

async function readReservation(
  response: APIResponse,
): Promise<ReservationResponse> {
  expect(response.status()).toBe(201);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  expect(response.headers()).not.toHaveProperty('idempotent-replay');

  const body = (await response.json()) as ReservationResponse;

  expect(Object.keys(body).sort()).toEqual(reservationFields);
  expect(body.reservationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(typeof body.quantity).toBe('number');
  expect(Number.isInteger(body.quantity)).toBe(true);
  expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);

  return body;
}

async function readReleasedReservation(
  response: APIResponse,
): Promise<ReleasedReservationResponse> {
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');

  const body = (await response.json()) as ReleasedReservationResponse;

  expect(Object.keys(body).sort()).toEqual(releasedReservationFields);
  expect(typeof body.quantity).toBe('number');
  expect(Number.isInteger(body.quantity)).toBe(true);
  expect(Number.isNaN(Date.parse(body.releasedAt))).toBe(false);
  expect(body).not.toHaveProperty('createdAt');
  expect(body).not.toHaveProperty('idempotencyKey');
  expect(body).not.toHaveProperty('fingerprint');

  return body;
}

function expectSafeReleaseBody(
  body: ReleasedReservationResponse,
  idempotencyKey: string,
): void {
  const serializedBody = JSON.stringify(body);

  expect(serializedBody).not.toContain(idempotencyKey);
  expect(serializedBody).not.toMatch(
    /fingerprint|password|postgres(?:ql)?:\/\/[^\s"]+@|connectionstring|stack|\.env|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|[a-z]:\\|\/services\//i,
  );
}

test.describe('POST /reservations/:reservationId/release', () => {
  test('releases a reservation and replays the release idempotently', async ({
    request,
  }) => {
    const initialInventory = await readInventoryItem(
      await request.get(`/inventory/${sku}`),
    );

    expect(initialInventory).toEqual({
      sku,
      name: 'Reservation Release Idempotency Test Product',
      totalQuantity: 5,
      reservedQuantity: 0,
      availableQuantity: 5,
    });

    const orderId = randomUUID();
    const creationResponse = await request.post('/reservations', {
      headers: {
        'Idempotency-Key': `reservation-create-${randomUUID()}`,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: {
        orderId,
        sku: ' reservation-release-idemp-001 ',
        quantity: 2,
      },
    });
    const reservation = await readReservation(creationResponse);

    expect(reservation).toEqual({
      reservationId: reservation.reservationId,
      orderId,
      sku,
      quantity: 2,
      status: 'RESERVED',
      createdAt: reservation.createdAt,
    });

    const reservedInventory = await readInventoryItem(
      await request.get(`/inventory/${sku}`),
    );
    expect(reservedInventory).toEqual({
      sku,
      name: 'Reservation Release Idempotency Test Product',
      totalQuantity: 5,
      reservedQuantity: 2,
      availableQuantity: 3,
    });

    const releaseIdempotencyKey = `reservation-release-${randomUUID()}`;
    const releaseResponse = await request.post(
      `/reservations/${reservation.reservationId}/release`,
      {
        headers: {
          'Idempotency-Key': releaseIdempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
      },
    );

    expect(releaseResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    const releasedReservation = await readReleasedReservation(
      releaseResponse,
    );
    expect(releasedReservation).toEqual({
      reservationId: reservation.reservationId,
      orderId,
      sku,
      quantity: 2,
      status: 'RELEASED',
      releasedAt: releasedReservation.releasedAt,
    });
    expectSafeReleaseBody(releasedReservation, releaseIdempotencyKey);

    const releasedInventory = await readInventoryItem(
      await request.get(`/inventory/${sku}`),
    );
    expect(releasedInventory).toEqual({
      sku,
      name: 'Reservation Release Idempotency Test Product',
      totalQuantity: 5,
      reservedQuantity: 0,
      availableQuantity: 5,
    });

    const replayResponse = await request.post(
      `/reservations/${reservation.reservationId}/release`,
      {
        headers: {
          'Idempotency-Key': releaseIdempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
      },
    );

    expect(replayResponse.headers()['idempotent-replay']).toBe('true');
    const replayedRelease = await readReleasedReservation(replayResponse);
    expect(replayedRelease).toEqual(releasedReservation);
    expect(replayedRelease.reservationId).toBe(reservation.reservationId);
    expect(replayedRelease.releasedAt).toBe(releasedReservation.releasedAt);
    expect(replayedRelease.status).toBe('RELEASED');
    expectSafeReleaseBody(replayedRelease, releaseIdempotencyKey);

    const replayedInventory = await readInventoryItem(
      await request.get(`/inventory/${sku}`),
    );
    expect(replayedInventory).toEqual({
      sku,
      name: 'Reservation Release Idempotency Test Product',
      totalQuantity: 5,
      reservedQuantity: 0,
      availableQuantity: 5,
    });
  });
});
