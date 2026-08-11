import { randomUUID } from 'node:crypto';

import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';

interface OrderResponse {
  orderId: string;
  sku: string;
  quantity: number;
  amountInCents: number;
  currency: string;
  status: string;
  createdAt: string;
}

const publicOrderFields = [
  'amountInCents',
  'createdAt',
  'currency',
  'orderId',
  'quantity',
  'sku',
  'status',
];

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

  expect(Object.keys(body).sort()).toEqual(publicOrderFields);
  expect(typeof body.orderId).toBe('string');
  expect(body.orderId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(typeof body.sku).toBe('string');
  expect(typeof body.quantity).toBe('number');
  expect(Number.isInteger(body.quantity)).toBe(true);
  expect(typeof body.amountInCents).toBe('number');
  expect(Number.isInteger(body.amountInCents)).toBe(true);
  expect(typeof body.currency).toBe('string');
  expect(body.status).toBe('PENDING');
  expect(typeof body.createdAt).toBe('string');
  expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);

  return body;
}

function expectSafeOrderBody(
  body: OrderResponse,
  idempotencyKey: string,
): void {
  const serializedBody = JSON.stringify(body);

  expect(serializedBody).not.toContain('tok_approved');
  expect(serializedBody).not.toContain(idempotencyKey);
  expect(serializedBody).not.toMatch(
    /paymentToken|idempotencyKey|requestFingerprint|fingerprint|updatedAt|inventoryReservationId|paymentId|failureCode|correlationId/i,
  );
  expect(serializedBody).not.toMatch(
    /password|postgres(?:ql)?:\/\/[^\s"]+@|connection[ _-]?string|stack(?: trace)?|\.env|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|node_modules|services[\\/]|[a-z]:\\/i,
  );
}

interface OrderRequestBody {
  sku: string;
  quantity: number;
  amountInCents: number;
  currency: string;
  paymentToken: string;
}

async function expectIdempotencyConflict(
  response: APIResponse,
  sensitiveValues: string[],
): Promise<void> {
  expect(response.status()).toBe(409);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  expect(response.headers()).not.toHaveProperty('idempotent-replay');

  const body = (await response.json()) as unknown;

  expect(body).toEqual({
    code: 'IDEMPOTENCY_KEY_CONFLICT',
    message: 'The idempotency key was already used with a different request.',
  });

  const serializedBody = JSON.stringify(body);

  for (const sensitiveValue of sensitiveValues) {
    expect(serializedBody).not.toContain(sensitiveValue);
  }
  expect(serializedBody).not.toMatch(
    /orderId|paymentToken|idempotencyKey|requestFingerprint|fingerprint/i,
  );
  expect(serializedBody).not.toMatch(
    /password|postgres(?:ql)?:\/\/[^\s"]+@|connection[ _-]?string|stack(?: trace)?|\.env|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|node_modules|services[\\/]|[a-z]:\\/i,
  );
}

async function expectOriginalOrderReplay(
  request: APIRequestContext,
  idempotencyKey: string,
  requestBody: OrderRequestBody,
  createdOrder: OrderResponse,
): Promise<void> {
  const replayResponse = await request.post(
    'http://127.0.0.1:3001/orders',
    {
      headers: {
        'Idempotency-Key': idempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: requestBody,
    },
  );

  expect(replayResponse.headers()['idempotent-replay']).toBe('true');
  const replayedOrder = await readPendingOrder(replayResponse, 200);

  expect(replayedOrder).toEqual(createdOrder);
  expect(replayedOrder.orderId).toBe(createdOrder.orderId);
  expect(replayedOrder.createdAt).toBe(createdOrder.createdAt);
  expectSafeOrderBody(replayedOrder, idempotencyKey);
}

test.describe('POST /orders', () => {
  test('creates a pending order and replays the same request idempotently', async ({
    request,
  }) => {
    const idempotencyKey = `order-${randomUUID()}`;
    const requestBody = {
      sku: ' book-001 ',
      quantity: 2,
      amountInCents: 5990,
      currency: ' brl ',
      paymentToken: ' tok_approved ',
    };

    const creationResponse = await request.post(
      'http://127.0.0.1:3001/orders',
      {
        headers: {
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: requestBody,
      },
    );

    expect(creationResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    const createdOrder = await readPendingOrder(creationResponse, 201);

    expect(createdOrder).toEqual({
      orderId: createdOrder.orderId,
      sku: 'BOOK-001',
      quantity: 2,
      amountInCents: 5990,
      currency: 'BRL',
      status: 'PENDING',
      createdAt: createdOrder.createdAt,
    });
    expectSafeOrderBody(createdOrder, idempotencyKey);

    const replayResponse = await request.post(
      'http://127.0.0.1:3001/orders',
      {
        headers: {
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: requestBody,
      },
    );

    expect(replayResponse.headers()['idempotent-replay']).toBe('true');
    const replayedOrder = await readPendingOrder(replayResponse, 200);

    expect(replayedOrder).toEqual(createdOrder);
    expect(replayedOrder.orderId).toBe(createdOrder.orderId);
    expect(replayedOrder.createdAt).toBe(createdOrder.createdAt);
    expect(replayedOrder.status).toBe('PENDING');
    expectSafeOrderBody(replayedOrder, idempotencyKey);
  });

  test.describe('idempotency conflicts', () => {
    test('rejects reuse of an idempotency key with a different sku', async ({
      request,
    }) => {
      const idempotencyKey = `order-${randomUUID()}`;
      const originalBody: OrderRequestBody = {
        sku: 'BOOK-001',
        quantity: 2,
        amountInCents: 5990,
        currency: 'BRL',
        paymentToken: 'tok_approved',
      };

      const creationResponse = await request.post(
        'http://127.0.0.1:3001/orders',
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
          data: originalBody,
        },
      );
      const createdOrder = await readPendingOrder(creationResponse, 201);

      const conflictResponse = await request.post(
        'http://127.0.0.1:3001/orders',
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
          data: { ...originalBody, sku: 'BOOK-002' },
        },
      );

      await expectIdempotencyConflict(conflictResponse, [
        idempotencyKey,
        originalBody.paymentToken,
      ]);
      await expectOriginalOrderReplay(
        request,
        idempotencyKey,
        originalBody,
        createdOrder,
      );
    });

    test('rejects reuse of an idempotency key with a different quantity', async ({
      request,
    }) => {
      const idempotencyKey = `order-${randomUUID()}`;
      const originalBody: OrderRequestBody = {
        sku: 'BOOK-001',
        quantity: 2,
        amountInCents: 5990,
        currency: 'BRL',
        paymentToken: 'tok_approved',
      };

      const creationResponse = await request.post(
        'http://127.0.0.1:3001/orders',
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
          data: originalBody,
        },
      );
      const createdOrder = await readPendingOrder(creationResponse, 201);

      const conflictResponse = await request.post(
        'http://127.0.0.1:3001/orders',
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
          data: { ...originalBody, quantity: 3 },
        },
      );

      await expectIdempotencyConflict(conflictResponse, [
        idempotencyKey,
        originalBody.paymentToken,
      ]);
      await expectOriginalOrderReplay(
        request,
        idempotencyKey,
        originalBody,
        createdOrder,
      );
    });

    test('rejects reuse of an idempotency key with a different amount', async ({
      request,
    }) => {
      const idempotencyKey = `order-${randomUUID()}`;
      const originalBody: OrderRequestBody = {
        sku: 'BOOK-001',
        quantity: 2,
        amountInCents: 5990,
        currency: 'BRL',
        paymentToken: 'tok_approved',
      };

      const creationResponse = await request.post(
        'http://127.0.0.1:3001/orders',
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
          data: originalBody,
        },
      );
      const createdOrder = await readPendingOrder(creationResponse, 201);

      const conflictResponse = await request.post(
        'http://127.0.0.1:3001/orders',
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
          data: { ...originalBody, amountInCents: 6990 },
        },
      );

      await expectIdempotencyConflict(conflictResponse, [
        idempotencyKey,
        originalBody.paymentToken,
      ]);
      await expectOriginalOrderReplay(
        request,
        idempotencyKey,
        originalBody,
        createdOrder,
      );
    });

    test('rejects reuse of an idempotency key with a different payment token', async ({
      request,
    }) => {
      const idempotencyKey = `order-${randomUUID()}`;
      const originalBody: OrderRequestBody = {
        sku: 'BOOK-001',
        quantity: 2,
        amountInCents: 5990,
        currency: 'BRL',
        paymentToken: 'tok_approved',
      };

      const creationResponse = await request.post(
        'http://127.0.0.1:3001/orders',
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
          data: originalBody,
        },
      );
      const createdOrder = await readPendingOrder(creationResponse, 201);

      const conflictBody: OrderRequestBody = {
        ...originalBody,
        paymentToken: 'tok_declined',
      };
      const conflictResponse = await request.post(
        'http://127.0.0.1:3001/orders',
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
          data: conflictBody,
        },
      );

      expect(conflictBody).toEqual({
        ...originalBody,
        paymentToken: 'tok_declined',
      });
      await expectIdempotencyConflict(conflictResponse, [
        idempotencyKey,
        originalBody.paymentToken,
        conflictBody.paymentToken,
      ]);
      await expectOriginalOrderReplay(
        request,
        idempotencyKey,
        originalBody,
        createdOrder,
      );
    });
  });
});
