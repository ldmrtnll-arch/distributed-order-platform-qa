import { createHash, randomUUID } from 'node:crypto';

import { expect, test, type APIResponse } from '@playwright/test';

import { queryOrderDatabase } from '../../support/database.js';
import {
  cleanupOrderInventoryFixture,
  countInventoryReservationsBySku,
  countOrdersByIdempotencyKey,
  readInventoryProduct,
  readInventoryReservationsByOrderId,
  readOrderById,
  type OrderDatabaseRow,
} from '../../support/order-inventory-database.js';
import { orderInventoryFixtures } from '../../support/order-inventory-fixtures.js';
import {
  readPaymentsByOrderId,
  type PaymentDatabaseRow,
} from '../../support/order-payment-database.js';

interface OrderResponse {
  orderId: string;
  sku: string;
  quantity: number;
  amountInCents: number;
  currency: string;
  status: string;
  createdAt: string;
}

interface ColumnRow {
  column_name: string;
}

const orderUrl = 'http://127.0.0.1:3001/orders';
const testKeyPrefix = 'db-order-test-';
const orderRowFields = [
  'amount',
  'createdAt',
  'currency',
  'failureCode',
  'idempotencyKey',
  'inventoryReservationId',
  'orderId',
  'paymentId',
  'quantity',
  'requestFingerprint',
  'sku',
  'status',
  'updatedAt',
];

function createRequestBody(sku: string): {
  sku: string;
  quantity: number;
  amountInCents: number;
  currency: string;
  paymentToken: string;
} {
  return {
    sku,
    quantity: 2,
    amountInCents: 5990,
    currency: 'BRL',
    paymentToken: 'tok_approved',
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
  expect(body.status).toBe('CONFIRMED');
  return body;
}

function expectConfirmedRow(
  row: OrderDatabaseRow,
  order: OrderResponse,
  idempotencyKey: string,
  sku: string,
): void {
  expect(Object.keys(row).sort()).toEqual(orderRowFields);
  expect(row.orderId).toBe(order.orderId);
  expect(row.sku).toBe(sku);
  expect(row.quantity).toBe(2);
  expect(row.amount).toBe(5990);
  expect(row.currency).toBe('BRL');
  expect(row.status).toBe('CONFIRMED');
  expect(row.inventoryReservationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(row.paymentId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(row.failureCode).toBeNull();
  expect(row.idempotencyKey === idempotencyKey).toBe(true);
  expect(row.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(Number.isNaN(Date.parse(String(row.createdAt)))).toBe(false);
  expect(Number.isNaN(Date.parse(String(row.updatedAt)))).toBe(false);
  expect(row.createdAt.toISOString()).toBe(order.createdAt);
}

async function expectApprovedPaymentRow(
  orderId: string,
  paymentId: string,
): Promise<PaymentDatabaseRow[]> {
  const payments = await readPaymentsByOrderId(orderId);
  expect(payments).toHaveLength(1);
  expect(payments[0]).toMatchObject({
    paymentId,
    orderId,
    amountInCents: 5990,
    currency: 'BRL',
    status: 'APPROVED',
    declineCode: null,
    idempotencyKey: `order:${orderId}:payment`,
  });
  expect(payments[0]?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  return payments;
}

test.describe('POST /orders database consistency', () => {
  test('persists a confirmed order consistently across Order, Inventory, and Payment', async ({
    request,
  }) => {
    const fixture = orderInventoryFixtures.database;
    const idempotencyKey = `${testKeyPrefix}persistence-${randomUUID()}`;
    const requestBody = createRequestBody(fixture.sku);

    try {
      const [initialOrderCount, initialReservationCount, initialProduct] =
        await Promise.all([
          countOrdersByIdempotencyKey(idempotencyKey),
          countInventoryReservationsBySku(fixture.sku),
          readInventoryProduct(fixture.sku),
        ]);

      expect(initialOrderCount).toBe(0);
      expect(initialReservationCount).toBe(0);
      expect(initialProduct).toEqual({
        sku: fixture.sku,
        totalQuantity: fixture.totalQuantity,
        reservedQuantity: 0,
        availableQuantity: fixture.totalQuantity,
      });

      const response = await request.post(orderUrl, {
        headers: {
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: requestBody,
      });
      expect(response.headers()).not.toHaveProperty('idempotent-replay');
      const order = await readOrder(response, 201);
      expect(order).toEqual({
        orderId: order.orderId,
        sku: fixture.sku,
        quantity: 2,
        amountInCents: 5990,
        currency: 'BRL',
        status: 'CONFIRMED',
        createdAt: order.createdAt,
      });

      const rows = await readOrderById(order.orderId);

      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toBeDefined();
      if (row === undefined) throw new Error('Persisted order was not found.');
      expectConfirmedRow(row, order, idempotencyKey, fixture.sku);
      const inventoryReservationId = row.inventoryReservationId;
      if (inventoryReservationId === null) {
        throw new Error('Persisted Order has no Inventory reservation.');
      }
      const paymentId = row.paymentId;
      if (paymentId === null) {
        throw new Error('Persisted Order has no Payment.');
      }

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
      expect(row.requestFingerprint.length).toBe(64);
      expect(row.requestFingerprint === expectedFingerprint).toBe(true);
      expect(row.createdAt.toISOString()).toBe(order.createdAt);
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(
        row.createdAt.getTime(),
      );

      const reservationRows =
        await readInventoryReservationsByOrderId(order.orderId);
      expect(reservationRows).toEqual([
        {
          reservationId: inventoryReservationId,
          orderId: order.orderId,
          sku: fixture.sku,
          quantity: 2,
          status: 'RESERVED',
          releaseIdempotencyKey: null,
          releaseRequestFingerprint: null,
          releasedAt: null,
        },
      ]);

      expect(await readInventoryProduct(fixture.sku)).toEqual({
        sku: fixture.sku,
        totalQuantity: fixture.totalQuantity,
        reservedQuantity: 2,
        availableQuantity: fixture.totalQuantity - 2,
      });
      await expectApprovedPaymentRow(order.orderId, paymentId);

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
      await cleanupOrderInventoryFixture({
        idempotencyKey,
        sku: fixture.sku,
        totalQuantity: fixture.totalQuantity,
      });

      const [remainingOrders, remainingReservations, restoredProduct] =
        await Promise.all([
          countOrdersByIdempotencyKey(idempotencyKey),
          countInventoryReservationsBySku(fixture.sku),
          readInventoryProduct(fixture.sku),
        ]);
      expect(remainingOrders).toBe(0);
      expect(remainingReservations).toBe(0);
      expect(restoredProduct).toEqual({
        sku: fixture.sku,
        totalQuantity: fixture.totalQuantity,
        reservedQuantity: 0,
        availableQuantity: fixture.totalQuantity,
      });
    }
  });

  test('does not create another database row or update timestamps on idempotent replay', async ({
    request,
  }) => {
    const fixture = orderInventoryFixtures.databaseReplay;
    const idempotencyKey = `${testKeyPrefix}replay-${randomUUID()}`;
    const requestBody = createRequestBody(fixture.sku);

    try {
      const [initialOrderCount, initialReservationCount, initialProduct] =
        await Promise.all([
          countOrdersByIdempotencyKey(idempotencyKey),
          countInventoryReservationsBySku(fixture.sku),
          readInventoryProduct(fixture.sku),
        ]);
      expect(initialOrderCount).toBe(0);
      expect(initialReservationCount).toBe(0);
      expect(initialProduct).toEqual({
        sku: fixture.sku,
        totalQuantity: fixture.totalQuantity,
        reservedQuantity: 0,
        availableQuantity: fixture.totalQuantity,
      });

      const creationResponse = await request.post(orderUrl, {
        headers: {
          'Idempotency-Key': idempotencyKey,
          'X-Correlation-Id': `correlation-${randomUUID()}`,
        },
        data: requestBody,
      });
      expect(creationResponse.headers()).not.toHaveProperty(
        'idempotent-replay',
      );
      const createdOrder = await readOrder(creationResponse, 201);
      const rowsBefore = await readOrderById(createdOrder.orderId);
      expect(rowsBefore).toHaveLength(1);
      expect(await countOrdersByIdempotencyKey(idempotencyKey)).toBe(1);
      const rowBefore = rowsBefore[0];
      expect(rowBefore).toBeDefined();
      if (rowBefore === undefined) {
        throw new Error('Persisted order was not found.');
      }
      expectConfirmedRow(
        rowBefore,
        createdOrder,
        idempotencyKey,
        fixture.sku,
      );
      const inventoryReservationId = rowBefore.inventoryReservationId;
      if (inventoryReservationId === null) {
        throw new Error('Persisted Order has no Inventory reservation.');
      }
      const paymentId = rowBefore.paymentId;
      if (paymentId === null) {
        throw new Error('Persisted Order has no Payment.');
      }

      const reservationsBefore =
        await readInventoryReservationsByOrderId(createdOrder.orderId);
      expect(reservationsBefore).toEqual([
        {
          reservationId: inventoryReservationId,
          orderId: createdOrder.orderId,
          sku: fixture.sku,
          quantity: 2,
          status: 'RESERVED',
          releaseIdempotencyKey: null,
          releaseRequestFingerprint: null,
          releasedAt: null,
        },
      ]);
      const productAfterCreation = await readInventoryProduct(fixture.sku);
      expect(productAfterCreation).toEqual({
        sku: fixture.sku,
        totalQuantity: fixture.totalQuantity,
        reservedQuantity: 2,
        availableQuantity: fixture.totalQuantity - 2,
      });
      const paymentsBefore = await expectApprovedPaymentRow(
        createdOrder.orderId,
        paymentId,
      );

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

      const rowsAfter = await readOrderById(createdOrder.orderId);
      expect(rowsAfter).toHaveLength(1);
      expect(await countOrdersByIdempotencyKey(idempotencyKey)).toBe(1);
      expect(rowsAfter).toEqual(rowsBefore);
      const rowAfter = rowsAfter[0];
      expect(rowAfter).toBeDefined();
      if (rowAfter === undefined) throw new Error('Persisted order was not found.');
      expect(rowAfter.orderId).toBe(createdOrder.orderId);
      expect(rowAfter.status).toBe('CONFIRMED');
      expect(rowAfter.inventoryReservationId).toBe(inventoryReservationId);
      expect(rowAfter.createdAt.toISOString()).toBe(
        rowBefore.createdAt.toISOString(),
      );
      expect(rowAfter.updatedAt.toISOString()).toBe(
        rowBefore.updatedAt.toISOString(),
      );

      const reservationsAfter =
        await readInventoryReservationsByOrderId(createdOrder.orderId);
      expect(reservationsAfter).toHaveLength(1);
      expect(reservationsAfter).toEqual(reservationsBefore);
      expect(reservationsAfter[0]?.reservationId).toBe(
        inventoryReservationId,
      );
      const productAfterReplay = await readInventoryProduct(fixture.sku);
      expect(productAfterReplay).toEqual(productAfterCreation);
      expect(productAfterReplay?.reservedQuantity).toBe(2);
      expect(productAfterReplay?.reservedQuantity).not.toBe(4);
      expect(await readPaymentsByOrderId(createdOrder.orderId)).toEqual(
        paymentsBefore,
      );
    } finally {
      await cleanupOrderInventoryFixture({
        idempotencyKey,
        sku: fixture.sku,
        totalQuantity: fixture.totalQuantity,
      });

      const [remainingOrders, remainingReservations, restoredProduct] =
        await Promise.all([
          countOrdersByIdempotencyKey(idempotencyKey),
          countInventoryReservationsBySku(fixture.sku),
          readInventoryProduct(fixture.sku),
        ]);
      expect(remainingOrders).toBe(0);
      expect(remainingReservations).toBe(0);
      expect(restoredProduct).toEqual({
        sku: fixture.sku,
        totalQuantity: fixture.totalQuantity,
        reservedQuantity: 0,
        availableQuantity: fixture.totalQuantity,
      });
    }
  });

  test('persists only one row for concurrent requests with the same idempotency key', async ({
    request,
  }) => {
    const fixture = orderInventoryFixtures.databaseConcurrent;
    const idempotencyKey = `${testKeyPrefix}concurrent-${randomUUID()}`;
    const requestBody = createRequestBody(fixture.sku);
    const firstCorrelationId = `db-order-concurrent-first-${randomUUID()}`;
    const secondCorrelationId = `db-order-concurrent-second-${randomUUID()}`;

    try {
      const [initialOrderCount, initialReservationCount, initialProduct] =
        await Promise.all([
          countOrdersByIdempotencyKey(idempotencyKey),
          countInventoryReservationsBySku(fixture.sku),
          readInventoryProduct(fixture.sku),
        ]);
      expect(initialOrderCount).toBe(0);
      expect(initialReservationCount).toBe(0);
      expect(initialProduct).toEqual({
        sku: fixture.sku,
        totalQuantity: fixture.totalQuantity,
        reservedQuantity: 0,
        availableQuantity: fixture.totalQuantity,
      });
      expect(firstCorrelationId).not.toBe(secondCorrelationId);

      const responses = await Promise.all([
        request.post(orderUrl, {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': firstCorrelationId,
          },
          data: requestBody,
        }),
        request.post(orderUrl, {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': secondCorrelationId,
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
      expect(creationResponse.headers()).not.toHaveProperty(
        'idempotent-replay',
      );
      const createdOrder = await readOrder(creationResponse, 201);
      expect(replayResponse.headers()['idempotent-replay']).toBe('true');
      const replayedOrder = await readOrder(replayResponse, 200);
      expect(replayedOrder).toEqual(createdOrder);
      expect(replayedOrder.orderId).toBe(createdOrder.orderId);

      expect(await countOrdersByIdempotencyKey(idempotencyKey)).toBe(1);
      const rows = await readOrderById(createdOrder.orderId);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toBeDefined();
      if (row === undefined) throw new Error('Persisted order was not found.');
      expectConfirmedRow(row, createdOrder, idempotencyKey, fixture.sku);
      const inventoryReservationId = row.inventoryReservationId;
      if (inventoryReservationId === null) {
        throw new Error('Persisted Order has no Inventory reservation.');
      }
      const paymentId = row.paymentId;
      if (paymentId === null) {
        throw new Error('Persisted Order has no Payment.');
      }

      const reservationRows =
        await readInventoryReservationsByOrderId(createdOrder.orderId);
      expect(await countInventoryReservationsBySku(fixture.sku)).toBe(1);
      expect(reservationRows).toEqual([
        {
          reservationId: inventoryReservationId,
          orderId: createdOrder.orderId,
          sku: fixture.sku,
          quantity: 2,
          status: 'RESERVED',
          releaseIdempotencyKey: null,
          releaseRequestFingerprint: null,
          releasedAt: null,
        },
      ]);

      const productAfterRequests = await readInventoryProduct(fixture.sku);
      expect(productAfterRequests).toEqual({
        sku: fixture.sku,
        totalQuantity: fixture.totalQuantity,
        reservedQuantity: 2,
        availableQuantity: fixture.totalQuantity - 2,
      });
      expect(productAfterRequests?.reservedQuantity).not.toBe(4);
      await expectApprovedPaymentRow(createdOrder.orderId, paymentId);
    } finally {
      await cleanupOrderInventoryFixture({
        idempotencyKey,
        sku: fixture.sku,
        totalQuantity: fixture.totalQuantity,
      });

      const [remainingOrders, remainingReservations, restoredProduct] =
        await Promise.all([
          countOrdersByIdempotencyKey(idempotencyKey),
          countInventoryReservationsBySku(fixture.sku),
          readInventoryProduct(fixture.sku),
        ]);
      expect(remainingOrders).toBe(0);
      expect(remainingReservations).toBe(0);
      expect(restoredProduct).toEqual({
        sku: fixture.sku,
        totalQuantity: fixture.totalQuantity,
        reservedQuantity: 0,
        availableQuantity: fixture.totalQuantity,
      });
    }
  });
});
