import { randomUUID } from 'node:crypto';

import { expect, test, type APIResponse } from '@playwright/test';

interface PaymentResponse {
  paymentId: string;
  orderId: string;
  amountInCents: number;
  currency: string;
  status: string;
  createdAt: string;
}

const paymentResponseFields = [
  'amountInCents',
  'createdAt',
  'currency',
  'orderId',
  'paymentId',
  'status',
];

async function readApprovedPayment(
  response: APIResponse,
  expectedStatus: number,
): Promise<PaymentResponse> {
  expect(response.status()).toBe(expectedStatus);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');

  const body = (await response.json()) as PaymentResponse;

  expect(Object.keys(body).sort()).toEqual(paymentResponseFields);
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
  expect(body).not.toHaveProperty('declineCode');
  expect(body).not.toHaveProperty('paymentToken');

  return body;
}

function expectSafePaymentBody(body: PaymentResponse): void {
  const serializedBody = JSON.stringify(body);

  expect(serializedBody).not.toContain('tok_approved');
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
});
