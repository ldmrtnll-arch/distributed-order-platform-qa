import { randomUUID } from 'node:crypto';

import { expect, test, type APIResponse } from '@playwright/test';

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
});
