import { randomUUID } from 'node:crypto';

import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';

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

async function createReservedReservation(
  request: APIRequestContext,
  productSku: string,
  quantity: number,
): Promise<ReservationResponse> {
  const orderId = randomUUID();
  const response = await request.post('/reservations', {
    headers: {
      'Idempotency-Key': `reservation-create-${randomUUID()}`,
      'X-Correlation-Id': `correlation-${randomUUID()}`,
    },
    data: { orderId, sku: productSku, quantity },
  });
  const reservation = await readReservation(response);

  expect(reservation).toEqual({
    reservationId: reservation.reservationId,
    orderId,
    sku: productSku,
    quantity,
    status: 'RESERVED',
    createdAt: reservation.createdAt,
  });

  return reservation;
}

async function postRelease(
  request: APIRequestContext,
  reservationId: string,
  idempotencyKey: string,
): Promise<APIResponse> {
  return request.post(`/reservations/${reservationId}/release`, {
    headers: {
      'Idempotency-Key': idempotencyKey,
      'X-Correlation-Id': `correlation-${randomUUID()}`,
    },
  });
}

async function expectReleaseConflict(
  response: APIResponse,
  expectedBody: { code: string; message: string },
  sensitiveValues: string[],
): Promise<void> {
  expect(response.status()).toBe(409);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  expect(response.headers()).not.toHaveProperty('idempotent-replay');

  const body = (await response.json()) as unknown;
  expect(body).toEqual(expectedBody);

  const serializedBody = JSON.stringify(body);
  for (const sensitiveValue of sensitiveValues) {
    expect(serializedBody).not.toContain(sensitiveValue);
  }
  expect(serializedBody).not.toMatch(
    /fingerprint|password|postgres(?:ql)?:\/\/[^\s"]+@|connectionstring|stack|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|[a-z]:\\|\/services\//i,
  );
}

async function expectReservedInventory(
  request: APIRequestContext,
  productSku: string,
  productName: string,
): Promise<void> {
  expect(
    await readInventoryItem(await request.get(`/inventory/${productSku}`)),
  ).toEqual({
    sku: productSku,
    name: productName,
    totalQuantity: 5,
    reservedQuantity: 2,
    availableQuantity: 3,
  });
}

async function expectPublicReleaseError(
  response: APIResponse,
  expectedStatus: number,
  expectedBody: unknown,
  sensitiveValues: string[] = [],
): Promise<void> {
  expect(response.status()).toBe(expectedStatus);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  expect(response.headers()).not.toHaveProperty('idempotent-replay');

  const body = (await response.json()) as unknown;
  expect(body).toEqual(expectedBody);

  const serializedBody = JSON.stringify(body);
  for (const sensitiveValue of sensitiveValues) {
    expect(serializedBody).not.toContain(sensitiveValue);
  }
  expect(serializedBody).not.toMatch(
    /fingerprint|paymentToken|password|postgres(?:ql)?:\/\/[^\s"]+@|connectionstring|stack|\.env|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|[a-z]:\\|\/services\/|node_modules/i,
  );
}

const requiredIdempotencyKeyError = {
  code: 'IDEMPOTENCY_KEY_REQUIRED',
  message: 'The Idempotency-Key header is required.',
};

function invalidReleaseBody(reason: string): unknown {
  return {
    code: 'INVALID_RELEASE_REQUEST',
    message: 'The reservation release request is invalid.',
    details: { field: 'body', reason },
  };
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

  test('rejects releasing an already released reservation with a different key', async ({
    request,
  }) => {
    const productSku = 'RESERVATION-RELEASE-ALREADY-001';
    const productName = 'Reservation Already Released Test Product';
    const reservation = await createReservedReservation(
      request,
      productSku,
      2,
    );
    const originalReleaseKey = `reservation-release-${randomUUID()}`;
    const originalResponse = await postRelease(
      request,
      reservation.reservationId,
      originalReleaseKey,
    );

    expect(originalResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    const originalRelease = await readReleasedReservation(originalResponse);
    expect(originalRelease).toEqual({
      reservationId: reservation.reservationId,
      orderId: reservation.orderId,
      sku: productSku,
      quantity: 2,
      status: 'RELEASED',
      releasedAt: originalRelease.releasedAt,
    });
    expect(
      await readInventoryItem(await request.get(`/inventory/${productSku}`)),
    ).toEqual({
      sku: productSku,
      name: productName,
      totalQuantity: 5,
      reservedQuantity: 0,
      availableQuantity: 5,
    });

    const conflictingReleaseKey = `reservation-release-${randomUUID()}`;
    const conflictResponse = await postRelease(
      request,
      reservation.reservationId,
      conflictingReleaseKey,
    );
    await expectReleaseConflict(
      conflictResponse,
      {
        code: 'RESERVATION_ALREADY_RELEASED',
        message: 'The inventory reservation has already been released.',
      },
      [
        reservation.reservationId,
        originalReleaseKey,
        conflictingReleaseKey,
      ],
    );

    expect(
      await readInventoryItem(await request.get(`/inventory/${productSku}`)),
    ).toEqual({
      sku: productSku,
      name: productName,
      totalQuantity: 5,
      reservedQuantity: 0,
      availableQuantity: 5,
    });

    const replayResponse = await postRelease(
      request,
      reservation.reservationId,
      originalReleaseKey,
    );
    expect(replayResponse.headers()['idempotent-replay']).toBe('true');
    const replayedRelease = await readReleasedReservation(replayResponse);
    expect(replayedRelease).toEqual(originalRelease);
    expect(replayedRelease.releasedAt).toBe(originalRelease.releasedAt);
  });

  test('rejects reuse of a release idempotency key for another reservation', async ({
    request,
  }) => {
    const firstSku = 'RESERVATION-RELEASE-CONFLICT-A-001';
    const secondSku = 'RESERVATION-RELEASE-CONFLICT-B-001';
    const firstReservation = await createReservedReservation(
      request,
      firstSku,
      1,
    );
    const secondReservation = await createReservedReservation(
      request,
      secondSku,
      2,
    );

    expect(
      await readInventoryItem(await request.get(`/inventory/${firstSku}`)),
    ).toMatchObject({
      totalQuantity: 5,
      reservedQuantity: 1,
      availableQuantity: 4,
    });
    expect(
      await readInventoryItem(await request.get(`/inventory/${secondSku}`)),
    ).toMatchObject({
      totalQuantity: 5,
      reservedQuantity: 2,
      availableQuantity: 3,
    });

    const releaseKey = `reservation-release-${randomUUID()}`;
    const firstReleaseResponse = await postRelease(
      request,
      firstReservation.reservationId,
      releaseKey,
    );
    expect(firstReleaseResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    const firstRelease = await readReleasedReservation(firstReleaseResponse);
    expect(firstRelease.status).toBe('RELEASED');

    const conflictResponse = await postRelease(
      request,
      secondReservation.reservationId,
      releaseKey,
    );
    await expectReleaseConflict(
      conflictResponse,
      {
        code: 'IDEMPOTENCY_KEY_CONFLICT',
        message:
          'The idempotency key was already used with a different request.',
      },
      [
        firstReservation.reservationId,
        secondReservation.reservationId,
        releaseKey,
      ],
    );

    expect(
      await readInventoryItem(await request.get(`/inventory/${firstSku}`)),
    ).toMatchObject({
      totalQuantity: 5,
      reservedQuantity: 0,
      availableQuantity: 5,
    });
    expect(
      await readInventoryItem(await request.get(`/inventory/${secondSku}`)),
    ).toMatchObject({
      totalQuantity: 5,
      reservedQuantity: 2,
      availableQuantity: 3,
    });

    const replayResponse = await postRelease(
      request,
      firstReservation.reservationId,
      releaseKey,
    );
    expect(replayResponse.headers()['idempotent-replay']).toBe('true');
    expect(await readReleasedReservation(replayResponse)).toEqual(firstRelease);
    expect(
      await readInventoryItem(await request.get(`/inventory/${secondSku}`)),
    ).toMatchObject({
      totalQuantity: 5,
      reservedQuantity: 2,
      availableQuantity: 3,
    });
  });

  test.describe('request validation', () => {
    test('rejects an invalid reservationId', async ({ request }) => {
      const idempotencyKey = `reservation-release-${randomUUID()}`;
      const response = await postRelease(
        request,
        'not-a-valid-uuid',
        idempotencyKey,
      );

      await expectPublicReleaseError(
        response,
        400,
        {
          code: 'INVALID_RESERVATION_ID',
          message:
            'The reservationId path parameter must be a valid UUID.',
        },
        [idempotencyKey],
      );
    });

    test('returns not found for an unknown reservationId', async ({
      request,
    }) => {
      const reservationId = randomUUID();
      const idempotencyKey = `reservation-release-${randomUUID()}`;
      const response = await postRelease(
        request,
        reservationId,
        idempotencyKey,
      );

      await expectPublicReleaseError(
        response,
        404,
        {
          code: 'INVENTORY_RESERVATION_NOT_FOUND',
          message: 'Inventory reservation was not found.',
        },
        [reservationId, idempotencyKey],
      );
    });

    test('requires the Idempotency-Key header', async ({ request }) => {
      const productSku = 'RESERVATION-RELEASE-VALIDATION-HEADER-MISSING';
      const productName = 'Reservation Release Missing Header Test Product';
      const reservation = await createReservedReservation(
        request,
        productSku,
        2,
      );
      await expectReservedInventory(request, productSku, productName);

      const response = await request.post(
        `/reservations/${reservation.reservationId}/release`,
        {
          headers: {
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
        },
      );
      await expectPublicReleaseError(response, 400, requiredIdempotencyKeyError, [
        reservation.reservationId,
      ]);
      await expectReservedInventory(request, productSku, productName);
    });

    test('rejects an Idempotency-Key containing only spaces', async ({
      request,
    }) => {
      const productSku = 'RESERVATION-RELEASE-VALIDATION-HEADER-BLANK';
      const productName = 'Reservation Release Blank Header Test Product';
      const reservation = await createReservedReservation(
        request,
        productSku,
        2,
      );
      await expectReservedInventory(request, productSku, productName);

      const response = await request.post(
        `/reservations/${reservation.reservationId}/release`,
        {
          headers: {
            'Idempotency-Key': '   ',
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
        },
      );
      await expectPublicReleaseError(response, 400, requiredIdempotencyKeyError, [
        reservation.reservationId,
      ]);
      await expectReservedInventory(request, productSku, productName);
    });

    const bodyCases: Array<{
      name: string;
      sku: string;
      productName: string;
      data: unknown;
      headers?: Record<string, string>;
      reason: string;
      sensitiveValues?: string[];
    }> = [
      {
        name: 'rejects an empty JSON object request body',
        sku: 'RESERVATION-RELEASE-VALIDATION-OBJECT',
        productName: 'Reservation Release Object Body Test Product',
        data: {},
        reason: 'must be empty.',
      },
      {
        name: 'rejects a JSON array request body',
        sku: 'RESERVATION-RELEASE-VALIDATION-ARRAY',
        productName: 'Reservation Release Array Body Test Product',
        data: [],
        reason: 'must be empty.',
      },
      {
        name: 'rejects malformed JSON without exposing parser details',
        sku: 'RESERVATION-RELEASE-VALIDATION-MALFORMED',
        productName: 'Reservation Release Malformed JSON Test Product',
        data: '{"unexpected":',
        headers: { 'Content-Type': 'application/json' },
        reason: 'must contain valid JSON.',
        sensitiveValues: ['{"unexpected":', 'SyntaxError', 'Unexpected token'],
      },
      {
        name: 'rejects a raw body with a text/plain Content-Type',
        sku: 'RESERVATION-RELEASE-VALIDATION-TEXT',
        productName: 'Reservation Release Text Body Test Product',
        data: 'unexpected release body',
        headers: { 'Content-Type': 'text/plain' },
        reason: 'must be empty.',
        sensitiveValues: ['unexpected release body'],
      },
      {
        name: 'rejects a raw body without an application/json Content-Type',
        sku: 'RESERVATION-RELEASE-VALIDATION-RAW',
        productName: 'Reservation Release Raw Body Test Product',
        data: 'unexpected release body',
        reason: 'must be empty.',
        sensitiveValues: ['unexpected release body'],
      },
    ];

    for (const bodyCase of bodyCases) {
      test(bodyCase.name, async ({ request }) => {
        const reservation = await createReservedReservation(
          request,
          bodyCase.sku,
          2,
        );
        await expectReservedInventory(
          request,
          bodyCase.sku,
          bodyCase.productName,
        );
        const idempotencyKey = `reservation-release-${randomUUID()}`;
        const response = await request.post(
          `/reservations/${reservation.reservationId}/release`,
          {
            headers: {
              'Idempotency-Key': idempotencyKey,
              'X-Correlation-Id': `correlation-${randomUUID()}`,
              ...bodyCase.headers,
            },
            data: bodyCase.data,
          },
        );
        const inventoryAfterResponse = await readInventoryItem(
          await request.get(`/inventory/${bodyCase.sku}`),
        );

        if (response.status() !== 400) {
          console.log(
            JSON.stringify({
              validationBug: bodyCase.name,
              observedStatus: response.status(),
              observedBody: await response.json(),
              inventoryAfterResponse,
            }),
          );
        }

        await expectPublicReleaseError(
          response,
          400,
          invalidReleaseBody(bodyCase.reason),
          [
            reservation.reservationId,
            idempotencyKey,
            ...(bodyCase.sensitiveValues ?? []),
          ],
        );
        expect(inventoryAfterResponse).toEqual({
          sku: bodyCase.sku,
          name: bodyCase.productName,
          totalQuantity: 5,
          reservedQuantity: 2,
          availableQuantity: 3,
        });
      });
    }
  });
});
