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

interface OrderRequestError {
  code: 'IDEMPOTENCY_KEY_REQUIRED' | 'INVALID_ORDER_REQUEST';
  message: string;
  details?: {
    field: string;
    reason: string;
  };
}

const validOrderRequestBody: Record<string, unknown> = {
  sku: 'BOOK-001',
  quantity: 2,
  amountInCents: 5990,
  currency: 'BRL',
  paymentToken: 'tok_approved',
};

function withoutOrderField(field: string): Record<string, unknown> {
  const body = { ...validOrderRequestBody };
  delete body[field];
  return body;
}

async function postOrderForValidation(
  request: APIRequestContext,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<APIResponse> {
  return request.post('http://127.0.0.1:3001/orders', {
    headers: {
      ...(idempotencyKey === undefined
        ? {}
        : { 'Idempotency-Key': idempotencyKey }),
      'X-Correlation-Id': `correlation-${randomUUID()}`,
    },
    data: body,
  });
}

async function expectOrderRequestError(
  response: APIResponse,
  expectedBody: OrderRequestError,
  sensitiveValues: string[],
): Promise<void> {
  expect(response.status()).toBe(400);
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
    /orderId|idempotencyKey|requestFingerprint|fingerprint/i,
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

  test.describe('request validation', () => {
    test('requires the Idempotency-Key header', async ({ request }) => {
      const response = await postOrderForValidation(
        request,
        validOrderRequestBody,
      );

      await expectOrderRequestError(
        response,
        {
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'The Idempotency-Key header is required.',
        },
        ['tok_approved'],
      );
    });

    test('rejects an Idempotency-Key containing only spaces', async ({
      request,
    }) => {
      const response = await postOrderForValidation(
        request,
        validOrderRequestBody,
        '   ',
      );

      await expectOrderRequestError(
        response,
        {
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'The Idempotency-Key header is required.',
        },
        ['tok_approved'],
      );
    });

    const validationCases: Array<{
      name: string;
      body: () => Record<string, unknown>;
      field: string;
      reason: string;
    }> = [
      {
        name: 'rejects a request without sku',
        body: () => withoutOrderField('sku'),
        field: 'sku',
        reason: 'is required.',
      },
      {
        name: 'rejects a non-string sku',
        body: () => ({ ...validOrderRequestBody, sku: 123 }),
        field: 'sku',
        reason: 'must be a string.',
      },
      {
        name: 'rejects a sku containing only spaces',
        body: () => ({ ...validOrderRequestBody, sku: '   ' }),
        field: 'sku',
        reason: 'must be a non-empty string.',
      },
      {
        name: 'rejects a request without quantity',
        body: () => withoutOrderField('quantity'),
        field: 'quantity',
        reason: 'is required.',
      },
      {
        name: 'rejects quantity equal to zero',
        body: () => ({ ...validOrderRequestBody, quantity: 0 }),
        field: 'quantity',
        reason: 'must be greater than zero.',
      },
      {
        name: 'rejects a negative quantity',
        body: () => ({ ...validOrderRequestBody, quantity: -1 }),
        field: 'quantity',
        reason: 'must be greater than zero.',
      },
      {
        name: 'rejects a decimal quantity',
        body: () => ({ ...validOrderRequestBody, quantity: 1.5 }),
        field: 'quantity',
        reason: 'must be an integer.',
      },
      {
        name: 'rejects quantity sent as a string',
        body: () => ({ ...validOrderRequestBody, quantity: '2' }),
        field: 'quantity',
        reason: 'must be a finite number.',
      },
      {
        name: 'rejects quantity equal to null',
        body: () => ({ ...validOrderRequestBody, quantity: null }),
        field: 'quantity',
        reason: 'must be a finite number.',
      },
      {
        name: 'rejects a request without amountInCents',
        body: () => withoutOrderField('amountInCents'),
        field: 'amountInCents',
        reason: 'is required.',
      },
      {
        name: 'rejects amountInCents equal to zero',
        body: () => ({ ...validOrderRequestBody, amountInCents: 0 }),
        field: 'amountInCents',
        reason: 'must be greater than zero.',
      },
      {
        name: 'rejects a negative amountInCents',
        body: () => ({ ...validOrderRequestBody, amountInCents: -100 }),
        field: 'amountInCents',
        reason: 'must be greater than zero.',
      },
      {
        name: 'rejects a decimal amountInCents',
        body: () => ({ ...validOrderRequestBody, amountInCents: 5990.5 }),
        field: 'amountInCents',
        reason: 'must be an integer.',
      },
      {
        name: 'rejects amountInCents sent as a string',
        body: () => ({ ...validOrderRequestBody, amountInCents: '5990' }),
        field: 'amountInCents',
        reason: 'must be a finite number.',
      },
      {
        name: 'rejects amountInCents equal to null',
        body: () => ({ ...validOrderRequestBody, amountInCents: null }),
        field: 'amountInCents',
        reason: 'must be a finite number.',
      },
      {
        name: 'rejects a request without currency',
        body: () => withoutOrderField('currency'),
        field: 'currency',
        reason: 'is required.',
      },
      {
        name: 'rejects a non-string currency',
        body: () => ({ ...validOrderRequestBody, currency: 123 }),
        field: 'currency',
        reason: 'must be a string.',
      },
      {
        name: 'rejects a currency containing only spaces',
        body: () => ({ ...validOrderRequestBody, currency: '   ' }),
        field: 'currency',
        reason: 'must be a non-empty string.',
      },
      {
        name: 'rejects an unsupported currency',
        body: () => ({ ...validOrderRequestBody, currency: 'USD' }),
        field: 'currency',
        reason: 'must be BRL.',
      },
      {
        name: 'rejects a request without paymentToken',
        body: () => withoutOrderField('paymentToken'),
        field: 'paymentToken',
        reason: 'is required.',
      },
      {
        name: 'rejects a non-string paymentToken',
        body: () => ({ ...validOrderRequestBody, paymentToken: 123 }),
        field: 'paymentToken',
        reason: 'must be a string.',
      },
      {
        name: 'rejects a paymentToken containing only spaces',
        body: () => ({ ...validOrderRequestBody, paymentToken: '   ' }),
        field: 'paymentToken',
        reason: 'must be a non-empty string.',
      },
      {
        name: 'rejects an unexpected request field',
        body: () => ({
          ...validOrderRequestBody,
          unexpectedField: 'unexpected',
        }),
        field: 'unexpectedField',
        reason: 'is not allowed.',
      },
    ];

    for (const validationCase of validationCases) {
      test(validationCase.name, async ({ request }) => {
        const idempotencyKey = `order-${randomUUID()}`;
        const response = await postOrderForValidation(
          request,
          validationCase.body(),
          idempotencyKey,
        );

        await expectOrderRequestError(
          response,
          {
            code: 'INVALID_ORDER_REQUEST',
            message: 'The order request is invalid.',
            details: {
              field: validationCase.field,
              reason: validationCase.reason,
            },
          },
          ['tok_approved', idempotencyKey],
        );
      });
    }
  });
});
