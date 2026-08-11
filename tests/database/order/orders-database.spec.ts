import { createHash, randomUUID } from 'node:crypto';

import { expect, test, type APIResponse } from '@playwright/test';

import { queryOrderDatabase } from '../../support/database.js';

interface OrderResponse {
  orderId: string;
  sku: string;
  quantity: number;
  amountInCents: number;
  currency: string;
  status: string;
  createdAt: string;
}

interface OrderRow {
  order_id: string;
  sku: string;
  quantity: number;
  amount: number;
  currency: string;
  status: string;
  inventory_reservation_id: string | null;
  payment_id: string | null;
  failure_code: string | null;
  idempotency_key: string;
  request_fingerprint: string;
  created_at: Date;
  updated_at: Date;
}

interface CountRow {
  count: number;
}

interface ColumnRow {
  column_name: string;
}

const orderUrl = 'http://127.0.0.1:3001/orders';
const testKeyPrefix = 'db-order-test-';
const orderRowFields = [
  'amount',
  'created_at',
  'currency',
  'failure_code',
  'idempotency_key',
  'inventory_reservation_id',
  'order_id',
  'payment_id',
  'quantity',
  'request_fingerprint',
  'sku',
  'status',
  'updated_at',
];

function createRequestBody(): {
  sku: string;
  quantity: number;
  amountInCents: number;
  currency: string;
  paymentToken: string;
} {
  return {
    sku: ' db-book-001 ',
    quantity: 2,
    amountInCents: 5990,
    currency: ' brl ',
    paymentToken: ' tok_approved ',
  };
}

async function readOrder(
  response: APIResponse,
  expectedStatus: number,
): Promise<OrderResponse> {
  expect(response.status()).toBe(expectedStatus);
  const body = (await response.json()) as OrderResponse;
  expect(body.orderId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(body.status).toBe('PENDING');
  return body;
}

async function readRowsByKey(idempotencyKey: string): Promise<OrderRow[]> {
  return queryOrderDatabase<OrderRow>(
    `
      SELECT
        order_id,
        sku,
        quantity,
        amount,
        currency,
        status,
        inventory_reservation_id,
        payment_id,
        failure_code,
        idempotency_key,
        request_fingerprint,
        created_at,
        updated_at
      FROM orders
      WHERE idempotency_key = $1
    `,
    [idempotencyKey],
  );
}

async function readCountByKey(idempotencyKey: string): Promise<number> {
  const rows = await queryOrderDatabase<CountRow>(
    `
      SELECT COUNT(*)::integer AS count
      FROM orders
      WHERE idempotency_key = $1
    `,
    [idempotencyKey],
  );
  return rows[0]?.count ?? -1;
}

async function cleanupOrder(idempotencyKey: string): Promise<void> {
  await queryOrderDatabase(
    'DELETE FROM orders WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  expect(await readCountByKey(idempotencyKey)).toBe(0);
}

function expectPendingRow(
  row: OrderRow,
  order: OrderResponse,
  idempotencyKey: string,
): void {
  expect(Object.keys(row).sort()).toEqual(orderRowFields);
  expect(row.order_id).toBe(order.orderId);
  expect(row.sku).toBe('DB-BOOK-001');
  expect(row.quantity).toBe(2);
  expect(row.amount).toBe(5990);
  expect(row.currency).toBe('BRL');
  expect(row.status).toBe('PENDING');
  expect(row.inventory_reservation_id).toBeNull();
  expect(row.payment_id).toBeNull();
  expect(row.failure_code).toBeNull();
  expect(row.idempotency_key === idempotencyKey).toBe(true);
  expect(row.request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(Number.isNaN(Date.parse(String(row.created_at)))).toBe(false);
  expect(Number.isNaN(Date.parse(String(row.updated_at)))).toBe(false);
  expect(new Date(row.created_at).toISOString()).toBe(order.createdAt);
}

test.describe('POST /orders database consistency', () => {
  test.afterAll(async () => {
    const remainingRows = await queryOrderDatabase<CountRow>(
      `
        SELECT COUNT(*)::integer AS count
        FROM orders
        WHERE idempotency_key LIKE $1
      `,
      [`${testKeyPrefix}%`],
    );
    expect(remainingRows).toEqual([{ count: 0 }]);
  });

  test('persists a pending order with the expected database state and fingerprint', async ({
    request,
  }) => {
    const idempotencyKey = `${testKeyPrefix}${randomUUID()}`;
    const requestBody = createRequestBody();

    try {
      const response = await request.post(orderUrl, {
        headers: {
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: requestBody,
      });
      const order = await readOrder(response, 201);

      const rows = await queryOrderDatabase<OrderRow>(
        `
          SELECT
            order_id,
            sku,
            quantity,
            amount,
            currency,
            status,
            inventory_reservation_id,
            payment_id,
            failure_code,
            idempotency_key,
            request_fingerprint,
            created_at,
            updated_at
          FROM orders
          WHERE order_id = $1
        `,
        [order.orderId],
      );

      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toBeDefined();
      if (row === undefined) throw new Error('Persisted order was not found.');
      expectPendingRow(row, order, idempotencyKey);

      const expectedFingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            requestBody.sku.trim().toUpperCase(),
            requestBody.quantity,
            requestBody.amountInCents,
            requestBody.currency.trim().toUpperCase(),
            requestBody.paymentToken.trim(),
          ]),
        )
        .digest('hex');
      expect(row.request_fingerprint.length).toBe(64);
      expect(row.request_fingerprint === expectedFingerprint).toBe(true);
      expect(new Date(row.created_at).toISOString()).toBe(order.createdAt);
      expect(new Date(row.created_at).toISOString()).toBe(
        new Date(row.updated_at).toISOString(),
      );

      const tokenColumns = await queryOrderDatabase<ColumnRow>(
        `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'orders'
            AND LOWER(column_name) LIKE '%token%'
        `,
      );
      expect(tokenColumns).toEqual([]);
    } finally {
      await cleanupOrder(idempotencyKey);
    }
  });

  test('does not create another database row or update timestamps on idempotent replay', async ({
    request,
  }) => {
    const idempotencyKey = `${testKeyPrefix}${randomUUID()}`;
    const requestBody = createRequestBody();

    try {
      const creationResponse = await request.post(orderUrl, {
        headers: {
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: requestBody,
      });
      const createdOrder = await readOrder(creationResponse, 201);
      const rowsBefore = await readRowsByKey(idempotencyKey);
      expect(rowsBefore).toHaveLength(1);
      expect(await readCountByKey(idempotencyKey)).toBe(1);

      const replayResponse = await request.post(orderUrl, {
        headers: {
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: requestBody,
      });
      expect(replayResponse.headers()['idempotent-replay']).toBe('true');
      const replayedOrder = await readOrder(replayResponse, 200);
      expect(replayedOrder).toEqual(createdOrder);

      const rowsAfter = await readRowsByKey(idempotencyKey);
      expect(rowsAfter).toHaveLength(1);
      expect(await readCountByKey(idempotencyKey)).toBe(1);
      expect(rowsAfter).toEqual(rowsBefore);
      const rowAfter = rowsAfter[0];
      expect(rowAfter).toBeDefined();
      if (rowAfter === undefined) throw new Error('Persisted order was not found.');
      expect(rowAfter.order_id).toBe(createdOrder.orderId);
      expect(rowAfter.status).toBe('PENDING');
    } finally {
      await cleanupOrder(idempotencyKey);
    }
  });

  test('persists only one row for concurrent requests with the same idempotency key', async ({
    request,
  }) => {
    const idempotencyKey = `${testKeyPrefix}${randomUUID()}`;
    const requestBody = createRequestBody();

    try {
      const responses = await Promise.all([
        request.post(orderUrl, {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
          data: requestBody,
        }),
        request.post(orderUrl, {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
          data: requestBody,
        }),
      ]);
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
      if (creationResponse === undefined || replayResponse === undefined) {
        throw new Error('Expected one creation response and one replay.');
      }
      const createdOrder = await readOrder(creationResponse, 201);
      expect(replayResponse.headers()['idempotent-replay']).toBe('true');
      const replayedOrder = await readOrder(replayResponse, 200);
      expect(replayedOrder).toEqual(createdOrder);
      expect(replayedOrder.orderId).toBe(createdOrder.orderId);

      expect(await readCountByKey(idempotencyKey)).toBe(1);
      const rows = await readRowsByKey(idempotencyKey);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toBeDefined();
      if (row === undefined) throw new Error('Persisted order was not found.');
      expectPendingRow(row, createdOrder, idempotencyKey);

      const thirdResponse = await request.post(orderUrl, {
        headers: {
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: requestBody,
      });
      expect(thirdResponse.status()).toBe(200);
      expect(thirdResponse.headers()['idempotent-replay']).toBe('true');
      expect(await thirdResponse.json()).toEqual(createdOrder);
      expect(await readCountByKey(idempotencyKey)).toBe(1);
    } finally {
      await cleanupOrder(idempotencyKey);
    }
  });
});
