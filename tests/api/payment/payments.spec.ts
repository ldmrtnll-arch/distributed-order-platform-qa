import { randomUUID } from 'node:crypto';

import { expect, test, type APIResponse } from '@playwright/test';

interface PaymentResponse {
  paymentId: string;
  orderId: string;
  amountInCents: number;
  currency: string;
  status: string;
  declineCode?: string;
  createdAt: string;
}

const approvedPaymentResponseFields = [
  'amountInCents',
  'createdAt',
  'currency',
  'orderId',
  'paymentId',
  'status',
];

const declinedPaymentResponseFields = [
  'amountInCents',
  'createdAt',
  'currency',
  'declineCode',
  'orderId',
  'paymentId',
  'status',
];

async function readPayment(
  response: APIResponse,
  expectedStatus: number,
  expectedFields: string[],
): Promise<PaymentResponse> {
  expect(response.status()).toBe(expectedStatus);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');

  const body = (await response.json()) as PaymentResponse;

  expect(Object.keys(body).sort()).toEqual(expectedFields);
  expect(typeof body.paymentId).toBe('string');
  expect(typeof body.orderId).toBe('string');
  expect(typeof body.amountInCents).toBe('number');
  expect(Number.isInteger(body.amountInCents)).toBe(true);
  expect(typeof body.currency).toBe('string');
  expect(typeof body.status).toBe('string');
  expect(typeof body.createdAt).toBe('string');
  expect(body.paymentId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
  expect(body).not.toHaveProperty('paymentToken');

  return body;
}

async function readApprovedPayment(
  response: APIResponse,
  expectedStatus: number,
): Promise<PaymentResponse> {
  const body = await readPayment(
    response,
    expectedStatus,
    approvedPaymentResponseFields,
  );

  expect(body).not.toHaveProperty('declineCode');

  return body;
}

async function readDeclinedPayment(
  response: APIResponse,
  expectedStatus: number,
): Promise<PaymentResponse> {
  const body = await readPayment(
    response,
    expectedStatus,
    declinedPaymentResponseFields,
  );

  expect(typeof body.declineCode).toBe('string');

  return body;
}

function expectSafePaymentBody(
  body: PaymentResponse,
  sensitiveTokens: string[] = ['tok_approved'],
): void {
  const serializedBody = JSON.stringify(body);

  for (const sensitiveToken of sensitiveTokens) {
    expect(serializedBody).not.toContain(sensitiveToken);
  }
  expect(serializedBody).not.toContain('paymentToken');
  expect(serializedBody).not.toMatch(
    /password|postgres(?:ql)?:\/\/[^\s"]+@|connectionstring|stack|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b/i,
  );
}

test.describe('POST /payments', () => {
  test('creates an approved payment and replays the same request idempotently', async ({
    request,
  }) => {
    const orderId = randomUUID();
    const idempotencyKey = `payment-${randomUUID()}`;
    const requestBody = {
      orderId,
      amountInCents: 15990,
      currency: ' brl ',
      paymentToken: 'tok_approved',
    };

    const creationResponse = await request.post(
      'http://127.0.0.1:3003/payments',
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
    const createdPayment = await readApprovedPayment(
      creationResponse,
      201,
    );

    expect(createdPayment).toEqual({
      paymentId: createdPayment.paymentId,
      orderId,
      amountInCents: 15990,
      currency: 'BRL',
      status: 'APPROVED',
      createdAt: createdPayment.createdAt,
    });
    expectSafePaymentBody(createdPayment);

    const replayResponse = await request.post(
      'http://127.0.0.1:3003/payments',
      {
        headers: {
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: requestBody,
      },
    );

    expect(replayResponse.headers()['idempotent-replay']).toBe('true');
    const replayedPayment = await readApprovedPayment(replayResponse, 200);

    expect(replayedPayment).toEqual(createdPayment);
    expect(replayedPayment.paymentId).toBe(createdPayment.paymentId);
    expect(replayedPayment.createdAt).toBe(createdPayment.createdAt);
    expect(replayedPayment.status).toBe('APPROVED');
    expectSafePaymentBody(replayedPayment);
  });

  test('processes a declined payment and replays the declined result idempotently', async ({
    request,
  }) => {
    const orderId = randomUUID();
    const idempotencyKey = `payment-${randomUUID()}`;
    const requestBody = {
      orderId,
      amountInCents: 15990,
      currency: 'BRL',
      paymentToken: 'tok_declined',
    };

    const creationResponse = await request.post(
      'http://127.0.0.1:3003/payments',
      {
        headers: {
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: requestBody,
      },
    );

    expect(creationResponse.status()).not.toBe(400);
    expect(creationResponse.status()).not.toBe(409);
    expect(creationResponse.status()).not.toBe(500);
    expect(creationResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    const declinedPayment = await readDeclinedPayment(
      creationResponse,
      201,
    );

    expect(declinedPayment).toEqual({
      paymentId: declinedPayment.paymentId,
      orderId,
      amountInCents: 15990,
      currency: 'BRL',
      status: 'DECLINED',
      declineCode: 'CARD_DECLINED',
      createdAt: declinedPayment.createdAt,
    });
    expectSafePaymentBody(declinedPayment, ['tok_declined']);

    const replayResponse = await request.post(
      'http://127.0.0.1:3003/payments',
      {
        headers: {
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: requestBody,
      },
    );

    expect(replayResponse.headers()['idempotent-replay']).toBe('true');
    const replayedPayment = await readDeclinedPayment(replayResponse, 200);

    expect(replayedPayment).toEqual(declinedPayment);
    expect(replayedPayment.paymentId).toBe(declinedPayment.paymentId);
    expect(replayedPayment.createdAt).toBe(declinedPayment.createdAt);
    expect(replayedPayment.status).toBe('DECLINED');
    expect(replayedPayment.declineCode).toBe('CARD_DECLINED');
    expectSafePaymentBody(replayedPayment, ['tok_declined']);
  });

  test('declines an unknown payment token with a generic public reason', async ({
    request,
  }) => {
    const orderId = randomUUID();
    const requestBody = {
      orderId,
      amountInCents: 8750,
      currency: ' brl ',
      paymentToken: 'tok_unknown_test_value',
    };

    const response = await request.post(
      'http://127.0.0.1:3003/payments',
      {
        headers: {
          'Idempotency-Key': `payment-${randomUUID()}`,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: requestBody,
      },
    );

    expect(response.headers()).not.toHaveProperty('idempotent-replay');
    const declinedPayment = await readDeclinedPayment(response, 201);

    expect(declinedPayment).toEqual({
      paymentId: declinedPayment.paymentId,
      orderId,
      amountInCents: 8750,
      currency: 'BRL',
      status: 'DECLINED',
      declineCode: 'PAYMENT_METHOD_REJECTED',
      createdAt: declinedPayment.createdAt,
    });
    expectSafePaymentBody(declinedPayment, [
      'tok_unknown_test_value',
    ]);
  });

  test('rejects reuse of an idempotency key with different payment data', async ({
    request,
  }) => {
    const orderId = randomUUID();
    const idempotencyKey = `payment-${randomUUID()}`;
    const originalRequestBody = {
      orderId,
      amountInCents: 12500,
      currency: 'BRL',
      paymentToken: 'tok_approved',
    };

    const creationResponse = await request.post(
      'http://127.0.0.1:3003/payments',
      {
        headers: {
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: originalRequestBody,
      },
    );

    expect(creationResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    const originalPayment = await readApprovedPayment(
      creationResponse,
      201,
    );

    expect(originalPayment).toEqual({
      paymentId: originalPayment.paymentId,
      orderId,
      amountInCents: 12500,
      currency: 'BRL',
      status: 'APPROVED',
      createdAt: originalPayment.createdAt,
    });
    expectSafePaymentBody(originalPayment);

    const conflictResponse = await request.post(
      'http://127.0.0.1:3003/payments',
      {
        headers: {
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: {
          ...originalRequestBody,
          paymentToken: 'tok_declined',
        },
      },
    );

    expect(conflictResponse.status()).toBe(409);
    expect(conflictResponse.headers()['content-type']).toMatch(
      /^application\/json(?:;|$)/,
    );
    expect(conflictResponse.headers()).not.toHaveProperty('x-powered-by');
    expect(conflictResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );

    const conflictBody = (await conflictResponse.json()) as unknown;

    expect(conflictBody).toEqual({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      message:
        'The idempotency key was already used with a different request.',
    });

    const serializedConflict = JSON.stringify(conflictBody);

    expect(serializedConflict).not.toContain('tok_approved');
    expect(serializedConflict).not.toContain('tok_declined');
    expect(serializedConflict).not.toContain('paymentToken');
    expect(serializedConflict).not.toContain(originalPayment.paymentId);
    expect(serializedConflict).not.toMatch(
      /password|postgres(?:ql)?:\/\/[^\s"]+@|connectionstring|stack|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b/i,
    );

    const replayResponse = await request.post(
      'http://127.0.0.1:3003/payments',
      {
        headers: {
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: originalRequestBody,
      },
    );

    expect(replayResponse.headers()['idempotent-replay']).toBe('true');
    const replayedPayment = await readApprovedPayment(replayResponse, 200);

    expect(replayedPayment).toEqual(originalPayment);
    expect(replayedPayment.paymentId).toBe(originalPayment.paymentId);
    expect(replayedPayment.createdAt).toBe(originalPayment.createdAt);
    expect(replayedPayment.status).toBe('APPROVED');
    expect(replayedPayment).not.toHaveProperty('declineCode');
    expectSafePaymentBody(replayedPayment, [
      'tok_approved',
      'tok_declined',
    ]);
  });
});
