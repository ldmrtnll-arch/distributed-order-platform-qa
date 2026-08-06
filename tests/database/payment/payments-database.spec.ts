import { randomUUID } from 'node:crypto';

import { expect, test, type APIResponse } from '@playwright/test';

import { queryPaymentDatabase } from '../../support/database.js';

interface PaymentResponse {
  paymentId: string;
  orderId: string;
  amountInCents: number;
  currency: string;
  status: string;
  declineCode?: string;
  createdAt: string;
}

interface PaymentRow {
  payment_id: string;
  order_id: string;
  amount_in_cents: number;
  currency: string;
  status: string;
  decline_code: string | null;
  idempotency_key: string;
  request_fingerprint: string;
  created_at: Date;
  updated_at: Date;
}

interface PaymentAggregateRow {
  row_count: number;
  payment_count: number;
}

const paymentUrl = 'http://127.0.0.1:3003/payments';
const approvedPaymentFields = [
  'amountInCents',
  'createdAt',
  'currency',
  'orderId',
  'paymentId',
  'status',
];
const declinedPaymentFields = [
  'amountInCents',
  'createdAt',
  'currency',
  'declineCode',
  'orderId',
  'paymentId',
  'status',
];
const paymentRowFields = [
  'amount_in_cents',
  'created_at',
  'currency',
  'decline_code',
  'idempotency_key',
  'order_id',
  'payment_id',
  'request_fingerprint',
  'status',
  'updated_at',
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
  expect(body.paymentId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
  expect(body).not.toHaveProperty('paymentToken');

  return body;
}

async function readPaymentRows(idempotencyKey: string): Promise<PaymentRow[]> {
  return queryPaymentDatabase<PaymentRow>(
    `
      SELECT
        payment_id,
        order_id,
        amount_in_cents,
        currency,
        status,
        decline_code,
        idempotency_key,
        request_fingerprint,
        created_at,
        updated_at
      FROM payments
      WHERE idempotency_key = $1
    `,
    [idempotencyKey],
  );
}

async function readPaymentAggregate(
  idempotencyKey: string,
): Promise<PaymentAggregateRow[]> {
  return queryPaymentDatabase<PaymentAggregateRow>(
    `
      SELECT
        COUNT(*)::integer AS row_count,
        COUNT(DISTINCT payment_id)::integer AS payment_count
      FROM payments
      WHERE idempotency_key = $1
    `,
    [idempotencyKey],
  );
}

function expectValidPersistedPayment(
  row: PaymentRow,
  payment: PaymentResponse,
  idempotencyKey: string,
): void {
  expect(Object.keys(row).sort()).toEqual(paymentRowFields);
  expect(row.payment_id).toBe(payment.paymentId);
  expect(row.order_id).toBe(payment.orderId);
  expect(row.amount_in_cents).toBe(payment.amountInCents);
  expect(row.currency).toBe(payment.currency);
  expect(row.status).toBe(payment.status);
  expect(row.idempotency_key).toBe(idempotencyKey);
  expect(row.request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(Number.isNaN(Date.parse(String(row.created_at)))).toBe(false);
  expect(Number.isNaN(Date.parse(String(row.updated_at)))).toBe(false);
  expect(new Date(row.created_at).toISOString()).toBe(payment.createdAt);
  expect(JSON.stringify(row)).not.toContain('paymentToken');
}

test.describe('POST /payments database consistency', () => {
  test('persists an approved payment consistently in the database', async ({
    request,
  }) => {
    const orderId = randomUUID();
    const idempotencyKey = `payment-db-${randomUUID()}`;
    const response = await request.post(paymentUrl, {
      headers: {
        'Idempotency-Key': idempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: {
        orderId,
        amountInCents: 34990,
        currency: ' brl ',
        paymentToken: 'tok_approved',
      },
    });

    expect(response.headers()).not.toHaveProperty('idempotent-replay');
    const payment = await readPayment(response, 201, approvedPaymentFields);

    expect(payment).toEqual({
      paymentId: payment.paymentId,
      orderId,
      amountInCents: 34990,
      currency: 'BRL',
      status: 'APPROVED',
      createdAt: payment.createdAt,
    });

    const rows = await readPaymentRows(idempotencyKey);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expectValidPersistedPayment(row, payment, idempotencyKey);
    expect(row.decline_code).toBeNull();
    expect(JSON.stringify(row)).not.toContain('tok_approved');
  });

  test('persists a declined payment with its public decline code', async ({
    request,
  }) => {
    const orderId = randomUUID();
    const idempotencyKey = `payment-db-${randomUUID()}`;
    const response = await request.post(paymentUrl, {
      headers: {
        'Idempotency-Key': idempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: {
        orderId,
        amountInCents: 8750,
        currency: 'BRL',
        paymentToken: 'tok_declined',
      },
    });

    const payment = await readPayment(response, 201, declinedPaymentFields);
    expect(payment).toEqual({
      paymentId: payment.paymentId,
      orderId,
      amountInCents: 8750,
      currency: 'BRL',
      status: 'DECLINED',
      declineCode: 'CARD_DECLINED',
      createdAt: payment.createdAt,
    });

    const rows = await readPaymentRows(idempotencyKey);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expectValidPersistedPayment(row, payment, idempotencyKey);
    expect(row.decline_code).toBe('CARD_DECLINED');
    expect(JSON.stringify(row)).not.toContain('tok_declined');
  });

  test('does not persist a duplicate payment during an idempotent replay', async ({
    request,
  }) => {
    const orderId = randomUUID();
    const idempotencyKey = `payment-db-${randomUUID()}`;
    const requestBody = {
      orderId,
      amountInCents: 12990,
      currency: 'BRL',
      paymentToken: 'tok_approved',
    };
    const headers = {
      'Idempotency-Key': idempotencyKey,
      'X-Correlation-Id': `correlation-${randomUUID()}`,
    };
    const creationResponse = await request.post(paymentUrl, {
      headers,
      data: requestBody,
    });
    const createdPayment = await readPayment(
      creationResponse,
      201,
      approvedPaymentFields,
    );
    const replayResponse = await request.post(paymentUrl, {
      headers: {
        ...headers,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: requestBody,
    });

    expect(replayResponse.headers()['idempotent-replay']).toBe('true');
    const replayedPayment = await readPayment(
      replayResponse,
      200,
      approvedPaymentFields,
    );
    expect(replayedPayment).toEqual(createdPayment);

    expect(await readPaymentAggregate(idempotencyKey)).toEqual([
      { row_count: 1, payment_count: 1 },
    ]);
    const rows = await readPaymentRows(idempotencyKey);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expectValidPersistedPayment(row, createdPayment, idempotencyKey);
    expect(row.amount_in_cents).toBe(12990);
    expect(row.status).toBe('APPROVED');
    expect(new Date(row.created_at).toISOString()).toBe(
      replayedPayment.createdAt,
    );
    expect(JSON.stringify(row)).not.toContain('tok_approved');
  });

  test('persists only one row for concurrent requests with the same idempotency key', async ({
    request,
  }) => {
    const orderId = randomUUID();
    const idempotencyKey = `payment-db-${randomUUID()}`;
    const requestBody = {
      orderId,
      amountInCents: 23990,
      currency: 'BRL',
      paymentToken: 'tok_approved',
    };

    const [firstResponse, secondResponse] = await Promise.all([
      request.post(paymentUrl, {
        headers: {
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: requestBody,
      }),
      request.post(paymentUrl, {
        headers: {
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: requestBody,
      }),
    ]);
    const responses = [firstResponse, secondResponse];

    expect(
      responses
        .map((response) => response.status())
        .sort((left, right) => left - right),
    ).toEqual([200, 201]);

    const creationResponse = responses.find(
      (response) => response.status() === 201,
    );
    const replayResponse = responses.find(
      (response) => response.status() === 200,
    );
    expect(creationResponse).toBeDefined();
    expect(replayResponse).toBeDefined();
    if (creationResponse === undefined || replayResponse === undefined) return;

    const createdPayment = await readPayment(
      creationResponse,
      201,
      approvedPaymentFields,
    );
    expect(replayResponse.headers()['idempotent-replay']).toBe('true');
    const replayedPayment = await readPayment(
      replayResponse,
      200,
      approvedPaymentFields,
    );
    expect(replayedPayment).toEqual(createdPayment);
    expect(replayedPayment.paymentId).toBe(createdPayment.paymentId);

    expect(await readPaymentAggregate(idempotencyKey)).toEqual([
      { row_count: 1, payment_count: 1 },
    ]);
    const rows = await readPaymentRows(idempotencyKey);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expectValidPersistedPayment(row, createdPayment, idempotencyKey);
    expect(row.amount_in_cents).toBe(23990);
    expect(row.status).toBe('APPROVED');
    expect(JSON.stringify(row)).not.toContain('tok_approved');
  });
});
