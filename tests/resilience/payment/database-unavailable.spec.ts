import { randomUUID } from 'node:crypto';

import { expect, test, type APIResponse } from '@playwright/test';

import { queryPaymentDatabase } from '../../support/database.js';
import {
  getPostgresStatus,
  getRabbitMqStatus,
  startPostgres,
  stopPostgres,
} from '../../support/docker-compose.js';
import { isPortReachable } from '../../support/inventory-service-process.js';
import { startPaymentService } from '../../support/payment-service-process.js';

interface PaymentResponse {
  paymentId: string;
  orderId: string;
  amountInCents: number;
  currency: string;
  status: string;
  createdAt: string;
}

interface CountRow {
  row_count: number;
}

interface ServiceLog {
  correlationId?: string;
  errorCode?: string;
  errorMessage?: string;
  errorName?: string;
  level?: string;
  operation?: string;
  orderId?: string;
  service?: string;
}

const approvedPaymentFields = [
  'amountInCents',
  'createdAt',
  'currency',
  'orderId',
  'paymentId',
  'status',
];

function parseServiceLogs(rawLogs: string): ServiceLog[] {
  return rawLogs
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ServiceLog];
      } catch {
        return [];
      }
    });
}

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

  expect(Object.keys(body).sort()).toEqual(approvedPaymentFields);
  expect(body.paymentId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
  expect(body).not.toHaveProperty('paymentToken');
  expect(body).not.toHaveProperty('declineCode');

  return body;
}

async function countPayments(idempotencyKey: string): Promise<number> {
  const rows = await queryPaymentDatabase<CountRow>(
    `
      SELECT COUNT(*)::integer AS row_count
      FROM payments
      WHERE idempotency_key = $1
    `,
    [idempotencyKey],
  );

  expect(rows).toHaveLength(1);
  return rows[0]?.row_count ?? -1;
}

test('returns 503 during a payment database outage and recovers without restarting', async ({
  request,
}) => {
  await expect
    .poll(async () => (await getPostgresStatus()).Health)
    .toBe('healthy');
  await expect
    .poll(async () => (await getRabbitMqStatus()).Health)
    .toBe('healthy');

  const serviceProcess = startPaymentService();
  const initialPid = serviceProcess.pid;

  console.log(
    JSON.stringify({ phase: 'initial', pid: initialPid, isRunning: true }),
  );

  try {
    await expect.poll(() => isPortReachable(3003)).toBe(true);

    const initialHealthResponse = await request.get('/health');
    expect(initialHealthResponse.status()).toBe(200);
    expect(initialHealthResponse.headers()['content-type']).toMatch(
      /^application\/json(?:;|$)/,
    );
    expect(initialHealthResponse.headers()).not.toHaveProperty('x-powered-by');
    await expect(initialHealthResponse.json()).resolves.toEqual({
      service: 'payment-service',
      status: 'UP',
      dependencies: { database: 'UP' },
    });

    const initialOrderId = randomUUID();
    const initialPaymentResponse = await request.post('/payments', {
      headers: {
        'Idempotency-Key': `payment-resilience-${randomUUID()}`,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: {
        orderId: initialOrderId,
        amountInCents: 15990,
        currency: 'BRL',
        paymentToken: 'tok_approved',
      },
    });
    const initialPayment = await readApprovedPayment(
      initialPaymentResponse,
      201,
    );
    expect(initialPayment).toMatchObject({
      orderId: initialOrderId,
      amountInCents: 15990,
      currency: 'BRL',
      status: 'APPROVED',
    });

    await stopPostgres();
    await expect
      .poll(async () => (await getPostgresStatus()).State.toLowerCase())
      .toMatch(/exited|stopped/u);

    console.log(
      JSON.stringify({
        phase: 'database-outage',
        pid: serviceProcess.pid,
        isRunning: serviceProcess.isRunning(),
      }),
    );
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);

    const unavailableHealthResponse = await request.get('/health');
    expect(unavailableHealthResponse.status()).toBe(503);
    expect(unavailableHealthResponse.headers()['content-type']).toMatch(
      /^application\/json(?:;|$)/,
    );
    expect(unavailableHealthResponse.headers()).not.toHaveProperty(
      'x-powered-by',
    );
    await expect(unavailableHealthResponse.json()).resolves.toEqual({
      service: 'payment-service',
      status: 'DEGRADED',
      dependencies: { database: 'DOWN' },
    });

    const failedOrderId = randomUUID();
    const failedIdempotencyKey = `payment-resilience-${randomUUID()}`;
    const failedCorrelationId = `correlation-${randomUUID()}`;
    const unavailablePaymentResponse = await request.post('/payments', {
      headers: {
        'Idempotency-Key': failedIdempotencyKey,
        'X-Correlation-Id': failedCorrelationId,
      },
      data: {
        orderId: failedOrderId,
        amountInCents: 25990,
        currency: 'BRL',
        paymentToken: 'tok_approved',
      },
    });

    expect(unavailablePaymentResponse.status()).toBe(503);
    expect(unavailablePaymentResponse.headers()['content-type']).toMatch(
      /^application\/json(?:;|$)/,
    );
    expect(unavailablePaymentResponse.headers()).not.toHaveProperty(
      'x-powered-by',
    );
    expect(unavailablePaymentResponse.headers()).not.toHaveProperty(
      'idempotent-replay',
    );
    await expect(unavailablePaymentResponse.json()).resolves.toEqual({
      code: 'PAYMENT_DATABASE_UNAVAILABLE',
      message: 'Payment data is temporarily unavailable.',
    });
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);

    await expect
      .poll(() => {
        const logs = parseServiceLogs(serviceProcess.logs());
        return {
          pool: logs.some((entry) => entry.operation === 'postgres-pool'),
          payment: logs.some((entry) => entry.operation === 'create-payment'),
        };
      })
      .toEqual({ pool: true, payment: true });

    const logs = parseServiceLogs(serviceProcess.logs());
    const poolError = logs.find((entry) => entry.operation === 'postgres-pool');
    const paymentError = logs.find(
      (entry) => entry.operation === 'create-payment',
    );

    expect(poolError).toMatchObject({
      level: 'error',
      service: 'payment-service',
      operation: 'postgres-pool',
    });
    expect(poolError?.errorMessage).toEqual(expect.any(String));
    expect(poolError?.errorMessage?.trim()).not.toBe('');
    expect(paymentError).toMatchObject({
      level: 'error',
      service: 'payment-service',
      operation: 'create-payment',
      orderId: failedOrderId,
      correlationId: failedCorrelationId,
    });
    expect(paymentError?.errorMessage).toEqual(expect.any(String));
    expect(paymentError?.errorMessage?.trim()).not.toBe('');

    const serializedErrorLogs = JSON.stringify([poolError, paymentError]);
    expect(serializedErrorLogs).not.toMatch(
      /tok_approved|paymentToken|password\s*[=:]\s*(?!\[REDACTED\])|postgres(?:ql)?:\/\/(?!\[REDACTED\]@)[^\s"]+@|connectionstring|stack|\.env|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|[a-z]:\\|\/services\//i,
    );

    await startPostgres();
    await expect
      .poll(async () => (await getPostgresStatus()).Health)
      .toBe('healthy');
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);

    await expect
      .poll(async () => {
        try {
          const response = await request.get('/health');
          if (response.status() !== 200) return null;
          return response.json();
        } catch {
          return null;
        }
      })
      .toEqual({
        service: 'payment-service',
        status: 'UP',
        dependencies: { database: 'UP' },
      });

    const recoveredOrderId = randomUUID();
    const recoveredIdempotencyKey = `payment-resilience-${randomUUID()}`;
    const recoveredRequestBody = {
      orderId: recoveredOrderId,
      amountInCents: 34990,
      currency: ' brl ',
      paymentToken: 'tok_approved',
    };
    const recoveredPaymentResponse = await request.post('/payments', {
      headers: {
        'Idempotency-Key': recoveredIdempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: recoveredRequestBody,
    });
    const recoveredPayment = await readApprovedPayment(
      recoveredPaymentResponse,
      201,
    );
    expect(recoveredPayment).toMatchObject({
      orderId: recoveredOrderId,
      amountInCents: 34990,
      currency: 'BRL',
      status: 'APPROVED',
    });

    const replayResponse = await request.post('/payments', {
      headers: {
        'Idempotency-Key': recoveredIdempotencyKey,
        'X-Correlation-Id': `correlation-${randomUUID()}`,
      },
      data: recoveredRequestBody,
    });
    expect(replayResponse.headers()['idempotent-replay']).toBe('true');
    const replayedPayment = await readApprovedPayment(replayResponse, 200);
    expect(replayedPayment).toEqual(recoveredPayment);
    expect(replayedPayment.paymentId).toBe(recoveredPayment.paymentId);

    expect(await countPayments(failedIdempotencyKey)).toBe(0);
    expect(await countPayments(recoveredIdempotencyKey)).toBe(1);
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);

    console.log(
      JSON.stringify({
        phase: 'recovered',
        pid: serviceProcess.pid,
        isRunning: serviceProcess.isRunning(),
        failedPaymentRows: 0,
        recoveredPaymentRows: 1,
      }),
    );
  } finally {
    await startPostgres();
    await expect
      .poll(async () => (await getPostgresStatus()).Health)
      .toBe('healthy');
    await serviceProcess.stop();
    await expect.poll(() => isPortReachable(3003)).toBe(false);
    await expect
      .poll(async () => (await getRabbitMqStatus()).Health)
      .toBe('healthy');
  }
});
