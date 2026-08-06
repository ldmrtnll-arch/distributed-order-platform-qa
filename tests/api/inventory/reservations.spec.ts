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

interface ValidationTestCase {
  name: string;
  controlSku: string;
  createHeaders: () => Record<string, string>;
  createBody: () => Record<string, unknown>;
  expectedBody:
    | {
        code: 'IDEMPOTENCY_KEY_REQUIRED';
        message: 'The Idempotency-Key header is required.';
      }
    | {
        code: 'INVALID_RESERVATION_REQUEST';
        message: 'The reservation request is invalid.';
        details: {
          field: string;
          reason: string;
        };
      };
}

interface PayloadTestCase {
  name: string;
  controlSku: string;
  sendRequest: (request: APIRequestContext) => Promise<APIResponse>;
  expectedReason: 'must be a JSON object.' | 'must contain valid JSON.';
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

async function expectInvalidReservationResponse(
  response: APIResponse,
  expectedBody: ValidationTestCase['expectedBody'],
): Promise<void> {
  expect(response.status()).toBe(400);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  expect(response.headers()).not.toHaveProperty('idempotent-replay');
  await expect(response.json()).resolves.toEqual(expectedBody);
}

async function expectInvalidPayloadResponse(
  response: APIResponse,
  expectedReason: PayloadTestCase['expectedReason'],
): Promise<void> {
  expect(response.status()).toBe(400);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  expect(response.headers()).not.toHaveProperty('idempotent-replay');

  const body: unknown = await response.json();

  expect(body).toEqual({
    code: 'INVALID_RESERVATION_REQUEST',
    message: 'The reservation request is invalid.',
    details: {
      field: 'body',
      reason: expectedReason,
    },
  });

  const serializedBody = JSON.stringify(body);

  expect(serializedBody).not.toMatch(
    /unexpected token|json parse|syntaxerror|stack|password|connectionstring|postgres(?:ql)?|\bsql\b|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|[a-z]:\\\\|\/services\//i,
  );
}

const validHeaders = (): Record<string, string> => ({
  'Idempotency-Key': `reservation-${randomUUID()}`,
  'X-Correlation-Id': `correlation-${randomUUID()}`,
});

const validationTestCases: ValidationTestCase[] = [
  {
    name: 'requires the Idempotency-Key header',
    controlSku: 'RESERVATION-VALIDATION-HEADER-MISSING',
    createHeaders: () => ({
      'X-Correlation-Id': `correlation-${randomUUID()}`,
    }),
    createBody: () => ({
      orderId: randomUUID(),
      sku: 'RESERVATION-VALIDATION-HEADER-MISSING',
      quantity: 1,
    }),
    expectedBody: {
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'The Idempotency-Key header is required.',
    },
  },
  {
    name: 'rejects an Idempotency-Key containing only spaces',
    controlSku: 'RESERVATION-VALIDATION-HEADER-EMPTY',
    createHeaders: () => ({
      'Idempotency-Key': '   ',
      'X-Correlation-Id': `correlation-${randomUUID()}`,
    }),
    createBody: () => ({
      orderId: randomUUID(),
      sku: 'RESERVATION-VALIDATION-HEADER-EMPTY',
      quantity: 1,
    }),
    expectedBody: {
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'The Idempotency-Key header is required.',
    },
  },
  {
    name: 'rejects a request without orderId',
    controlSku: 'RESERVATION-VALIDATION-ORDER-MISSING',
    createHeaders: validHeaders,
    createBody: () => ({
      sku: 'RESERVATION-VALIDATION-ORDER-MISSING',
      quantity: 1,
    }),
    expectedBody: {
      code: 'INVALID_RESERVATION_REQUEST',
      message: 'The reservation request is invalid.',
      details: { field: 'orderId', reason: 'is required.' },
    },
  },
  {
    name: 'rejects an invalid orderId',
    controlSku: 'RESERVATION-VALIDATION-ORDER-INVALID',
    createHeaders: validHeaders,
    createBody: () => ({
      orderId: 'not-a-uuid',
      sku: 'RESERVATION-VALIDATION-ORDER-INVALID',
      quantity: 1,
    }),
    expectedBody: {
      code: 'INVALID_RESERVATION_REQUEST',
      message: 'The reservation request is invalid.',
      details: { field: 'orderId', reason: 'must be a valid UUID.' },
    },
  },
  {
    name: 'rejects a request without sku',
    controlSku: 'RESERVATION-VALIDATION-SKU-MISSING',
    createHeaders: validHeaders,
    createBody: () => ({ orderId: randomUUID(), quantity: 1 }),
    expectedBody: {
      code: 'INVALID_RESERVATION_REQUEST',
      message: 'The reservation request is invalid.',
      details: { field: 'sku', reason: 'is required.' },
    },
  },
  {
    name: 'rejects a sku containing only spaces',
    controlSku: 'RESERVATION-VALIDATION-SKU-EMPTY',
    createHeaders: validHeaders,
    createBody: () => ({
      orderId: randomUUID(),
      sku: '   ',
      quantity: 1,
    }),
    expectedBody: {
      code: 'INVALID_RESERVATION_REQUEST',
      message: 'The reservation request is invalid.',
      details: { field: 'sku', reason: 'must be a non-empty string.' },
    },
  },
  {
    name: 'rejects a request without quantity',
    controlSku: 'RESERVATION-VALIDATION-QUANTITY-MISSING',
    createHeaders: validHeaders,
    createBody: () => ({
      orderId: randomUUID(),
      sku: 'RESERVATION-VALIDATION-QUANTITY-MISSING',
    }),
    expectedBody: {
      code: 'INVALID_RESERVATION_REQUEST',
      message: 'The reservation request is invalid.',
      details: { field: 'quantity', reason: 'is required.' },
    },
  },
  {
    name: 'rejects quantity equal to zero',
    controlSku: 'RESERVATION-VALIDATION-QUANTITY-ZERO',
    createHeaders: validHeaders,
    createBody: () => ({
      orderId: randomUUID(),
      sku: 'RESERVATION-VALIDATION-QUANTITY-ZERO',
      quantity: 0,
    }),
    expectedBody: {
      code: 'INVALID_RESERVATION_REQUEST',
      message: 'The reservation request is invalid.',
      details: { field: 'quantity', reason: 'must be greater than zero.' },
    },
  },
  {
    name: 'rejects a negative quantity',
    controlSku: 'RESERVATION-VALIDATION-QUANTITY-NEGATIVE',
    createHeaders: validHeaders,
    createBody: () => ({
      orderId: randomUUID(),
      sku: 'RESERVATION-VALIDATION-QUANTITY-NEGATIVE',
      quantity: -1,
    }),
    expectedBody: {
      code: 'INVALID_RESERVATION_REQUEST',
      message: 'The reservation request is invalid.',
      details: { field: 'quantity', reason: 'must be greater than zero.' },
    },
  },
  {
    name: 'rejects a decimal quantity',
    controlSku: 'RESERVATION-VALIDATION-QUANTITY-DECIMAL',
    createHeaders: validHeaders,
    createBody: () => ({
      orderId: randomUUID(),
      sku: 'RESERVATION-VALIDATION-QUANTITY-DECIMAL',
      quantity: 1.5,
    }),
    expectedBody: {
      code: 'INVALID_RESERVATION_REQUEST',
      message: 'The reservation request is invalid.',
      details: { field: 'quantity', reason: 'must be an integer.' },
    },
  },
  {
    name: 'rejects quantity sent as a string',
    controlSku: 'RESERVATION-VALIDATION-QUANTITY-STRING',
    createHeaders: validHeaders,
    createBody: () => ({
      orderId: randomUUID(),
      sku: 'RESERVATION-VALIDATION-QUANTITY-STRING',
      quantity: '1',
    }),
    expectedBody: {
      code: 'INVALID_RESERVATION_REQUEST',
      message: 'The reservation request is invalid.',
      details: { field: 'quantity', reason: 'must be a finite number.' },
    },
  },
  {
    name: 'rejects quantity equal to null',
    controlSku: 'RESERVATION-VALIDATION-QUANTITY-NULL',
    createHeaders: validHeaders,
    createBody: () => ({
      orderId: randomUUID(),
      sku: 'RESERVATION-VALIDATION-QUANTITY-NULL',
      quantity: null,
    }),
    expectedBody: {
      code: 'INVALID_RESERVATION_REQUEST',
      message: 'The reservation request is invalid.',
      details: { field: 'quantity', reason: 'must be a finite number.' },
    },
  },
  {
    name: 'rejects an unexpected request field',
    controlSku: 'RESERVATION-VALIDATION-UNEXPECTED-FIELD',
    createHeaders: validHeaders,
    createBody: () => ({
      orderId: randomUUID(),
      sku: 'RESERVATION-VALIDATION-UNEXPECTED-FIELD',
      quantity: 1,
      unexpectedField: true,
    }),
    expectedBody: {
      code: 'INVALID_RESERVATION_REQUEST',
      message: 'The reservation request is invalid.',
      details: { field: 'unexpectedField', reason: 'is not allowed.' },
    },
  },
];

const payloadTestCases: PayloadTestCase[] = [
  {
    name: 'rejects a completely missing request body',
    controlSku: 'RESERVATION-PAYLOAD-EMPTY',
    sendRequest: (request) =>
      request.post('/reservations', {
        headers: validHeaders(),
      }),
    expectedReason: 'must be a JSON object.',
  },
  {
    name: 'rejects a JSON array request body',
    controlSku: 'RESERVATION-PAYLOAD-ARRAY',
    sendRequest: (request) =>
      request.post('/reservations', {
        headers: {
          ...validHeaders(),
          'Content-Type': 'application/json',
        },
        data: [],
      }),
    expectedReason: 'must be a JSON object.',
  },
  {
    name: 'rejects malformed JSON without exposing parser details',
    controlSku: 'RESERVATION-PAYLOAD-MALFORMED',
    sendRequest: (request) =>
      request.post('/reservations', {
        headers: {
          ...validHeaders(),
          'Content-Type': 'application/json',
        },
        data: `{"orderId":"${randomUUID()}",`,
      }),
    expectedReason: 'must contain valid JSON.',
  },
  {
    name: 'rejects a raw JSON body without an application/json Content-Type',
    controlSku: 'RESERVATION-CONTENT-TYPE-MISSING',
    sendRequest: (request) => {
      const headers = validHeaders();

      expect(headers).not.toHaveProperty('Content-Type');
      expect(headers).not.toHaveProperty('content-type');

      return request.post('/reservations', {
        headers,
        data: JSON.stringify({
          orderId: randomUUID(),
          sku: 'RESERVATION-CONTENT-TYPE-MISSING',
          quantity: 1,
        }),
      });
    },
    expectedReason: 'must be a JSON object.',
  },
  {
    name: 'rejects a raw JSON body with a text/plain Content-Type',
    controlSku: 'RESERVATION-CONTENT-TYPE-INVALID',
    sendRequest: (request) =>
      request.post('/reservations', {
        headers: {
          ...validHeaders(),
          'Content-Type': 'text/plain',
        },
        data: JSON.stringify({
          orderId: randomUUID(),
          sku: 'RESERVATION-CONTENT-TYPE-INVALID',
          quantity: 1,
        }),
      }),
    expectedReason: 'must be a JSON object.',
  },
];

function concurrencySku(baseSku: string, repeatEachIndex: number): string {
  return repeatEachIndex === 0
    ? baseSku
    : `${baseSku}-REPEAT-${repeatEachIndex}`;
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

  test('prevents overselling when concurrent reservations dispute the last units', async ({
    request,
  }, testInfo) => {
    const sku = concurrencySku(
      'RESERVATION-CONCURRENCY-STOCK-001',
      testInfo.repeatEachIndex,
    );
    const inventoryBeforeResponse = await request.get(`/inventory/${sku}`);
    const inventoryBefore = await readInventoryItem(
      inventoryBeforeResponse,
    );

    expect(inventoryBefore).toMatchObject({
      sku,
      totalQuantity: 2,
      reservedQuantity: 0,
      availableQuantity: 2,
    });

    const firstOrderId = randomUUID();
    const secondOrderId = randomUUID();
    const [firstResponse, secondResponse] = await Promise.all([
      request.post('/reservations', {
        headers: {
          'Idempotency-Key': `reservation-${randomUUID()}`,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: { orderId: firstOrderId, sku, quantity: 2 },
      }),
      request.post('/reservations', {
        headers: {
          'Idempotency-Key': `reservation-${randomUUID()}`,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: { orderId: secondOrderId, sku, quantity: 2 },
      }),
    ]);
    const responses = [firstResponse, secondResponse];

    expect(responses.map((response) => response.status()).sort()).toEqual([
      201,
      409,
    ]);

    const createdResponse = responses.find(
      (response) => response.status() === 201,
    );
    const rejectedResponse = responses.find(
      (response) => response.status() === 409,
    );

    if (createdResponse === undefined || rejectedResponse === undefined) {
      throw new Error('Expected one created and one rejected response.');
    }

    expect(createdResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    const createdReservation = await readReservation(
      createdResponse,
      201,
    );

    expect([firstOrderId, secondOrderId]).toContain(
      createdReservation.orderId,
    );
    expect(createdReservation).toMatchObject({
      sku,
      quantity: 2,
      status: 'RESERVED',
    });

    expect(rejectedResponse.headers()['content-type']).toMatch(
      /^application\/json(?:;|$)/,
    );
    expect(rejectedResponse.headers()).not.toHaveProperty('x-powered-by');
    expect(rejectedResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    await expect(rejectedResponse.json()).resolves.toEqual({
      code: 'INVENTORY_INSUFFICIENT_STOCK',
      message: 'Insufficient inventory for the requested quantity.',
      details: {
        sku,
        requestedQuantity: 2,
        availableQuantity: 0,
      },
    });

    const inventoryAfterResponse = await request.get(`/inventory/${sku}`);
    const inventoryAfter = await readInventoryItem(inventoryAfterResponse);

    expect(inventoryAfter).toMatchObject({
      sku,
      totalQuantity: 2,
      reservedQuantity: 2,
      availableQuantity: 0,
    });
  });

  test('creates only one reservation for concurrent requests with the same idempotency key', async ({
    request,
  }, testInfo) => {
    const sku = concurrencySku(
      'RESERVATION-CONCURRENCY-IDEMP-001',
      testInfo.repeatEachIndex,
    );
    const inventoryBeforeResponse = await request.get(`/inventory/${sku}`);
    const inventoryBefore = await readInventoryItem(
      inventoryBeforeResponse,
    );

    expect(inventoryBefore).toMatchObject({
      sku,
      totalQuantity: 5,
      reservedQuantity: 0,
      availableQuantity: 5,
    });

    const orderId = randomUUID();
    const idempotencyKey = `reservation-${randomUUID()}`;
    const requestBody = { orderId, sku, quantity: 2 };
    const headers = {
      'Idempotency-Key': idempotencyKey,
      'X-Correlation-Id': `correlation-${randomUUID()}`,
    };
    const [firstResponse, secondResponse] = await Promise.all([
      request.post('/reservations', { headers, data: requestBody }),
      request.post('/reservations', { headers, data: requestBody }),
    ]);
    const responses = [firstResponse, secondResponse];

    expect(responses.map((response) => response.status()).sort()).toEqual([
      200,
      201,
    ]);

    const createdResponse = responses.find(
      (response) => response.status() === 201,
    );
    const replayResponse = responses.find(
      (response) => response.status() === 200,
    );

    if (createdResponse === undefined || replayResponse === undefined) {
      throw new Error('Expected one created and one replayed response.');
    }

    expect(createdResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    expect(replayResponse.headers()['idempotent-replay']).toBe('true');

    const createdReservation = await readReservation(
      createdResponse,
      201,
    );
    const replayedReservation = await readReservation(
      replayResponse,
      200,
    );

    expect(createdReservation).toMatchObject({
      orderId,
      sku,
      quantity: 2,
      status: 'RESERVED',
    });
    expect(replayedReservation).toEqual(createdReservation);
    expect(replayedReservation.reservationId).toBe(
      createdReservation.reservationId,
    );
    expect(replayedReservation.createdAt).toBe(createdReservation.createdAt);

    const inventoryAfterResponse = await request.get(`/inventory/${sku}`);
    const inventoryAfter = await readInventoryItem(inventoryAfterResponse);

    expect(inventoryAfter).toMatchObject({
      sku,
      totalQuantity: 5,
      reservedQuantity: 2,
      availableQuantity: 3,
    });
  });

  for (const validationCase of validationTestCases) {
    test(validationCase.name, async ({ request }) => {
      const inventoryBeforeResponse = await request.get(
        `/inventory/${validationCase.controlSku}`,
      );
      const inventoryBefore = await readInventoryItem(
        inventoryBeforeResponse,
      );

      expect(inventoryBefore).toMatchObject({
        sku: validationCase.controlSku,
        totalQuantity: 3,
        reservedQuantity: 0,
        availableQuantity: 3,
      });

      const response = await request.post('/reservations', {
        headers: validationCase.createHeaders(),
        data: validationCase.createBody(),
      });

      await expectInvalidReservationResponse(
        response,
        validationCase.expectedBody,
      );

      const inventoryAfterResponse = await request.get(
        `/inventory/${validationCase.controlSku}`,
      );
      const inventoryAfter = await readInventoryItem(
        inventoryAfterResponse,
      );

      expect(inventoryAfter).toMatchObject({
        sku: validationCase.controlSku,
        totalQuantity: 3,
        reservedQuantity: 0,
        availableQuantity: 3,
      });
    });
  }

  for (const payloadCase of payloadTestCases) {
    test(payloadCase.name, async ({ request }) => {
      const inventoryBeforeResponse = await request.get(
        `/inventory/${payloadCase.controlSku}`,
      );
      const inventoryBefore = await readInventoryItem(
        inventoryBeforeResponse,
      );

      expect(inventoryBefore).toMatchObject({
        sku: payloadCase.controlSku,
        totalQuantity: 3,
        reservedQuantity: 0,
        availableQuantity: 3,
      });

      const response = await payloadCase.sendRequest(request);

      await expectInvalidPayloadResponse(
        response,
        payloadCase.expectedReason,
      );

      const inventoryAfterResponse = await request.get(
        `/inventory/${payloadCase.controlSku}`,
      );
      const inventoryAfter = await readInventoryItem(
        inventoryAfterResponse,
      );

      expect(inventoryAfter).toMatchObject({
        sku: payloadCase.controlSku,
        totalQuantity: 3,
        reservedQuantity: 0,
        availableQuantity: 3,
      });
    });
  }
});
