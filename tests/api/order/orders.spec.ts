import { randomUUID } from 'node:crypto';

import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';

import { orderInventoryFixtures } from '../../support/order-inventory-fixtures.js';
import {
  cleanupOrderByIdempotencyKey,
  cleanupOrderInventoryFixture,
  countInventoryProductsBySku,
  countInventoryReservationsBySku,
  countOrdersByIdempotencyKey,
  readInventoryProduct,
  readInventoryReservationsByOrderId,
  readOrderById,
} from '../../support/order-inventory-database.js';

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
  expectedOrderStatus = 'PENDING',
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
  expect(body.status).toBe(expectedOrderStatus);
  expect(typeof body.createdAt).toBe('string');
  expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);

  return body;
}

function expectSafeOrderBody(
  body: OrderResponse,
  idempotencyKey: string,
  sensitiveValues: string[] = [],
): void {
  const serializedBody = JSON.stringify(body);

  expect(serializedBody).not.toContain('tok_approved');
  expect(serializedBody).not.toContain(idempotencyKey);
  for (const sensitiveValue of sensitiveValues) {
    expect(serializedBody).not.toContain(sensitiveValue);
  }
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
    /orderId|paymentToken|idempotencyKey|requestFingerprint|fingerprint|inventoryReservationId/i,
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
  test('creates an inventory-reserved order and replays the same request idempotently', async ({
    request,
  }) => {
    const fixture = orderInventoryFixtures.happyPath;
    const idempotencyKey = `order-happy-${randomUUID()}`;
    const creationCorrelationId = `order-happy-create-${randomUUID()}`;
    const replayCorrelationId = `order-happy-replay-${randomUUID()}`;
    const requestBody = {
      sku: ` ${fixture.sku.toLowerCase()} `,
      quantity: 2,
      amountInCents: 5990,
      currency: ' brl ',
      paymentToken: ' tok_approved ',
    };

    try {
      const initialProduct = await readInventoryProduct(fixture.sku);
      expect(initialProduct).toEqual({
        sku: fixture.sku,
        totalQuantity: fixture.totalQuantity,
        reservedQuantity: 0,
        availableQuantity: fixture.totalQuantity,
      });

      const initialOrders =
        await countOrdersByIdempotencyKey(idempotencyKey);
      expect(initialOrders).toBe(0);

      const initialReservations =
        await countInventoryReservationsBySku(fixture.sku);
      expect(initialReservations).toBe(0);

      const creationResponse = await request.post(
        'http://127.0.0.1:3001/orders',
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': creationCorrelationId,
          },
          data: requestBody,
        },
      );

      expect(creationResponse.headers()).not.toHaveProperty(
        'idempotent-replay',
      );
      const createdOrder = await readPendingOrder(
        creationResponse,
        201,
        'INVENTORY_RESERVED',
      );

      expect(createdOrder).toEqual({
        orderId: createdOrder.orderId,
        sku: fixture.sku,
        quantity: 2,
        amountInCents: 5990,
        currency: 'BRL',
        status: 'INVENTORY_RESERVED',
        createdAt: createdOrder.createdAt,
      });
      expectSafeOrderBody(createdOrder, idempotencyKey, [
        creationCorrelationId,
      ]);

      const createdOrderRows = await readOrderById(createdOrder.orderId);
      expect(createdOrderRows).toHaveLength(1);
      const createdOrderRow = createdOrderRows[0];
      expect(createdOrderRow).toBeDefined();
      expect(createdOrderRow).toMatchObject({
        orderId: createdOrder.orderId,
        status: 'INVENTORY_RESERVED',
        paymentId: null,
        failureCode: null,
      });
      expect(createdOrderRow?.inventoryReservationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      const inventoryReservationId =
        createdOrderRow?.inventoryReservationId;
      expect(inventoryReservationId).not.toBeNull();
      expect(inventoryReservationId).toBeDefined();

      const reservationRows =
        await readInventoryReservationsByOrderId(createdOrder.orderId);
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

      const productAfterCreation = await readInventoryProduct(fixture.sku);
      expect(productAfterCreation).toEqual({
        sku: fixture.sku,
        totalQuantity: fixture.totalQuantity,
        reservedQuantity: 2,
        availableQuantity: fixture.totalQuantity - 2,
      });

      expectSafeOrderBody(createdOrder, idempotencyKey, [
        creationCorrelationId,
        inventoryReservationId ?? '',
      ]);

      const replayResponse = await request.post(
        'http://127.0.0.1:3001/orders',
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': replayCorrelationId,
          },
          data: requestBody,
        },
      );

      expect(replayResponse.headers()['idempotent-replay']).toBe('true');
      const replayedOrder = await readPendingOrder(
        replayResponse,
        200,
        'INVENTORY_RESERVED',
      );

      expect(replayedOrder).toEqual(createdOrder);
      expect(replayedOrder.orderId).toBe(createdOrder.orderId);
      expect(replayedOrder.createdAt).toBe(createdOrder.createdAt);
      expect(replayedOrder.status).toBe('INVENTORY_RESERVED');
      expectSafeOrderBody(replayedOrder, idempotencyKey, [
        creationCorrelationId,
        replayCorrelationId,
        inventoryReservationId ?? '',
      ]);

      const replayedOrderRows = await readOrderById(createdOrder.orderId);
      expect(replayedOrderRows).toHaveLength(1);
      expect(replayedOrderRows[0]).toMatchObject({
        orderId: createdOrder.orderId,
        status: 'INVENTORY_RESERVED',
        inventoryReservationId,
        paymentId: null,
        failureCode: null,
      });
      expect(replayedOrderRows[0]?.updatedAt.toISOString()).toBe(
        createdOrderRow?.updatedAt.toISOString(),
      );

      const reservationsAfterReplay =
        await readInventoryReservationsByOrderId(createdOrder.orderId);
      expect(reservationsAfterReplay).toEqual(reservationRows);

      const productAfterReplay = await readInventoryProduct(fixture.sku);
      expect(productAfterReplay).toEqual(productAfterCreation);
    } finally {
      await cleanupOrderInventoryFixture({
        idempotencyKey,
        sku: fixture.sku,
        totalQuantity: fixture.totalQuantity,
      });

      const [remainingOrders, remainingReservations, restoredProducts] =
        await Promise.all([
          countOrdersByIdempotencyKey(idempotencyKey),
          countInventoryReservationsBySku(fixture.sku),
          readInventoryProduct(fixture.sku),
        ]);

      expect(remainingOrders).toBe(0);
      expect(remainingReservations).toBe(0);
      expect(restoredProducts).toEqual({
        sku: fixture.sku,
        totalQuantity: fixture.totalQuantity,
        reservedQuantity: 0,
        availableQuantity: fixture.totalQuantity,
      });
    }
  });

  test.describe('idempotency conflicts', () => {
    const conflictCases = [
      {
        title: 'rejects reuse of an idempotency key with a different sku',
        fixture: orderInventoryFixtures.idempotencyConflictSku,
        changedField: 'sku',
        changedValue: 'ORDER-CONFLICT-SKU-CHANGED',
      },
      {
        title:
          'rejects reuse of an idempotency key with a different quantity',
        fixture: orderInventoryFixtures.idempotencyConflictQuantity,
        changedField: 'quantity',
        changedValue: 3,
      },
      {
        title:
          'rejects reuse of an idempotency key with a different amount',
        fixture: orderInventoryFixtures.idempotencyConflictAmount,
        changedField: 'amountInCents',
        changedValue: 6990,
      },
      {
        title:
          'rejects reuse of an idempotency key with a different payment token',
        fixture: orderInventoryFixtures.idempotencyConflictToken,
        changedField: 'paymentToken',
        changedValue: 'tok_declined',
      },
    ] as const satisfies ReadonlyArray<{
      title: string;
      fixture: {
        readonly sku: string;
        readonly totalQuantity: number;
      };
      changedField: keyof OrderRequestBody;
      changedValue: string | number;
    }>;

    for (const conflictCase of conflictCases) {
      test(conflictCase.title, async ({ request }) => {
        const { fixture } = conflictCase;
        const idempotencyKey = `order-conflict-${conflictCase.changedField}-${randomUUID()}`;
        const creationCorrelationId = `order-conflict-create-${randomUUID()}`;
        const conflictCorrelationId = `order-conflict-attempt-${randomUUID()}`;
        const replayCorrelationId = `order-conflict-replay-${randomUUID()}`;
        const originalBody: OrderRequestBody = {
          sku: fixture.sku,
          quantity: 2,
          amountInCents: 5990,
          currency: 'BRL',
          paymentToken: 'tok_approved',
        };
        const conflictBody: OrderRequestBody = {
          ...originalBody,
          [conflictCase.changedField]: conflictCase.changedValue,
        };

        expect(conflictBody).toEqual({
          ...originalBody,
          [conflictCase.changedField]: conflictCase.changedValue,
        });

        try {
          const [initialProduct, initialReservations, initialOrders] =
            await Promise.all([
              readInventoryProduct(fixture.sku),
              countInventoryReservationsBySku(fixture.sku),
              countOrdersByIdempotencyKey(idempotencyKey),
            ]);

          expect(initialProduct).toEqual({
            sku: fixture.sku,
            totalQuantity: fixture.totalQuantity,
            reservedQuantity: 0,
            availableQuantity: fixture.totalQuantity,
          });
          expect(initialReservations).toBe(0);
          expect(initialOrders).toBe(0);

          const creationResponse = await request.post(
            'http://127.0.0.1:3001/orders',
            {
              headers: {
                'Idempotency-Key': idempotencyKey,
                'X-Correlation-Id': creationCorrelationId,
              },
              data: originalBody,
            },
          );

          expect(creationResponse.headers()).not.toHaveProperty(
            'idempotent-replay',
          );
          const createdOrder = await readPendingOrder(
            creationResponse,
            201,
            'INVENTORY_RESERVED',
          );
          expect(createdOrder).toEqual({
            orderId: createdOrder.orderId,
            sku: fixture.sku,
            quantity: 2,
            amountInCents: 5990,
            currency: 'BRL',
            status: 'INVENTORY_RESERVED',
            createdAt: createdOrder.createdAt,
          });
          expectSafeOrderBody(createdOrder, idempotencyKey, [
            creationCorrelationId,
          ]);

          const [createdOrderRows, createdReservations, productAfterCreation] =
            await Promise.all([
              readOrderById(createdOrder.orderId),
              readInventoryReservationsByOrderId(createdOrder.orderId),
              readInventoryProduct(fixture.sku),
            ]);

          expect(createdOrderRows).toHaveLength(1);
          const createdOrderRow = createdOrderRows[0];
          expect(createdOrderRow).toBeDefined();
          if (createdOrderRow === undefined) {
            throw new Error('Created Order row was not found.');
          }
          expect(createdOrderRow).toMatchObject({
            orderId: createdOrder.orderId,
            status: 'INVENTORY_RESERVED',
            paymentId: null,
            failureCode: null,
          });
          expect(createdOrderRow.inventoryReservationId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          );
          const inventoryReservationId =
            createdOrderRow.inventoryReservationId;
          if (inventoryReservationId === null) {
            throw new Error('Created Order has no Inventory reservation.');
          }
          const createdUpdatedAt = createdOrderRow.updatedAt.toISOString();

          expect(createdReservations).toEqual([
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
          const createdReservationId =
            createdReservations[0]?.reservationId;
          expect(createdReservationId).toBe(inventoryReservationId);

          expect(productAfterCreation).toEqual({
            sku: fixture.sku,
            totalQuantity: fixture.totalQuantity,
            reservedQuantity: 2,
            availableQuantity: fixture.totalQuantity - 2,
          });
          expectSafeOrderBody(createdOrder, idempotencyKey, [
            creationCorrelationId,
            inventoryReservationId,
          ]);

          const conflictResponse = await request.post(
            'http://127.0.0.1:3001/orders',
            {
              headers: {
                'Idempotency-Key': idempotencyKey,
                'X-Correlation-Id': conflictCorrelationId,
              },
              data: conflictBody,
            },
          );

          const conflictSensitiveValues = [
            idempotencyKey,
            originalBody.paymentToken,
            createdOrder.orderId,
            inventoryReservationId,
            creationCorrelationId,
            conflictCorrelationId,
            ...(conflictCase.changedField === 'paymentToken'
              ? [String(conflictCase.changedValue)]
              : []),
          ];
          await expectIdempotencyConflict(
            conflictResponse,
            conflictSensitiveValues,
          );

          const [
            orderRowsAfterConflict,
            reservationsAfterConflict,
            productAfterConflict,
          ] = await Promise.all([
            readOrderById(createdOrder.orderId),
            readInventoryReservationsByOrderId(createdOrder.orderId),
            readInventoryProduct(fixture.sku),
          ]);

          expect(orderRowsAfterConflict).toHaveLength(1);
          expect(orderRowsAfterConflict[0]).toMatchObject({
            orderId: createdOrder.orderId,
            status: 'INVENTORY_RESERVED',
            inventoryReservationId,
            paymentId: null,
            failureCode: null,
          });
          expect(orderRowsAfterConflict[0]?.updatedAt.toISOString()).toBe(
            createdUpdatedAt,
          );
          expect(reservationsAfterConflict).toHaveLength(1);
          expect(reservationsAfterConflict).toEqual(createdReservations);
          expect(reservationsAfterConflict[0]?.reservationId).toBe(
            createdReservationId,
          );
          expect(productAfterConflict).toEqual(productAfterCreation);

          if (conflictCase.changedField === 'sku') {
            expect(
              await countInventoryReservationsBySku(
                String(conflictCase.changedValue),
              ),
            ).toBe(0);
          }

          const replayResponse = await request.post(
            'http://127.0.0.1:3001/orders',
            {
              headers: {
                'Idempotency-Key': idempotencyKey,
                'X-Correlation-Id': replayCorrelationId,
              },
              data: originalBody,
            },
          );

          expect(replayResponse.headers()['idempotent-replay']).toBe('true');
          const replayedOrder = await readPendingOrder(
            replayResponse,
            200,
            'INVENTORY_RESERVED',
          );
          expect(replayedOrder).toEqual(createdOrder);
          expect(replayedOrder.orderId).toBe(createdOrder.orderId);
          expect(replayedOrder.createdAt).toBe(createdOrder.createdAt);
          expect(replayedOrder.status).toBe('INVENTORY_RESERVED');
          expectSafeOrderBody(replayedOrder, idempotencyKey, [
            creationCorrelationId,
            conflictCorrelationId,
            replayCorrelationId,
            inventoryReservationId,
            ...(conflictCase.changedField === 'paymentToken'
              ? [String(conflictCase.changedValue)]
              : []),
          ]);

          const [
            orderRowsAfterReplay,
            reservationsAfterReplay,
            productAfterReplay,
            orderCountAfterReplay,
          ] = await Promise.all([
            readOrderById(createdOrder.orderId),
            readInventoryReservationsByOrderId(createdOrder.orderId),
            readInventoryProduct(fixture.sku),
            countOrdersByIdempotencyKey(idempotencyKey),
          ]);

          expect(orderCountAfterReplay).toBe(1);
          expect(orderRowsAfterReplay).toHaveLength(1);
          expect(orderRowsAfterReplay[0]).toMatchObject({
            orderId: createdOrder.orderId,
            status: 'INVENTORY_RESERVED',
            inventoryReservationId,
            paymentId: null,
            failureCode: null,
          });
          expect(orderRowsAfterReplay[0]?.updatedAt.toISOString()).toBe(
            createdUpdatedAt,
          );
          expect(reservationsAfterReplay).toHaveLength(1);
          expect(reservationsAfterReplay).toEqual(createdReservations);
          expect(reservationsAfterReplay[0]?.reservationId).toBe(
            createdReservationId,
          );
          expect(productAfterReplay).toEqual(productAfterCreation);
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
    }
  });

  test.describe('inventory rejection', () => {
    test('creates an inventory-rejected order when the sku does not exist', async ({
      request,
    }) => {
      const missingSku = 'ORDER-NOT-FOUND-001';
      const idempotencyKey = `order-rejection-not-found-${randomUUID()}`;
      const creationCorrelationId = `order-rejection-not-found-create-${randomUUID()}`;
      const replayCorrelationId = `order-rejection-not-found-replay-${randomUUID()}`;
      const requestBody: OrderRequestBody = {
        sku: ' order-not-found-001 ',
        quantity: 1,
        amountInCents: 5990,
        currency: ' brl ',
        paymentToken: ' tok_approved ',
      };

      try {
        const [initialProductCount, initialReservations, initialOrders] =
          await Promise.all([
            countInventoryProductsBySku(missingSku),
            countInventoryReservationsBySku(missingSku),
            countOrdersByIdempotencyKey(idempotencyKey),
          ]);

        expect(initialProductCount).toBe(0);
        expect(initialReservations).toBe(0);
        expect(initialOrders).toBe(0);

        const creationResponse = await request.post(
          'http://127.0.0.1:3001/orders',
          {
            headers: {
              'Idempotency-Key': idempotencyKey,
              'X-Correlation-Id': creationCorrelationId,
            },
            data: requestBody,
          },
        );

        expect(creationResponse.headers()).not.toHaveProperty(
          'idempotent-replay',
        );
        const createdOrder = await readPendingOrder(
          creationResponse,
          201,
          'INVENTORY_REJECTED',
        );
        expect(createdOrder).toEqual({
          orderId: createdOrder.orderId,
          sku: missingSku,
          quantity: 1,
          amountInCents: 5990,
          currency: 'BRL',
          status: 'INVENTORY_REJECTED',
          createdAt: createdOrder.createdAt,
        });
        expectSafeOrderBody(createdOrder, idempotencyKey, [
          creationCorrelationId,
          'INVENTORY_ITEM_NOT_FOUND',
        ]);

        const [
          createdOrderRows,
          reservationsByOrder,
          productCountAfterCreation,
          reservationsBySkuAfterCreation,
        ] = await Promise.all([
          readOrderById(createdOrder.orderId),
          readInventoryReservationsByOrderId(createdOrder.orderId),
          countInventoryProductsBySku(missingSku),
          countInventoryReservationsBySku(missingSku),
        ]);

        expect(createdOrderRows).toHaveLength(1);
        const createdOrderRow = createdOrderRows[0];
        expect(createdOrderRow).toBeDefined();
        if (createdOrderRow === undefined) {
          throw new Error('Created Order row was not found.');
        }
        expect(createdOrderRow).toMatchObject({
          orderId: createdOrder.orderId,
          status: 'INVENTORY_REJECTED',
          inventoryReservationId: null,
          paymentId: null,
          failureCode: 'INVENTORY_ITEM_NOT_FOUND',
        });
        expect(createdOrderRow.createdAt.toISOString()).toBe(
          createdOrder.createdAt,
        );
        const createdUpdatedAt = createdOrderRow.updatedAt.toISOString();

        expect(reservationsByOrder).toHaveLength(0);
        expect(productCountAfterCreation).toBe(0);
        expect(reservationsBySkuAfterCreation).toBe(0);

        const replayResponse = await request.post(
          'http://127.0.0.1:3001/orders',
          {
            headers: {
              'Idempotency-Key': idempotencyKey,
              'X-Correlation-Id': replayCorrelationId,
            },
            data: requestBody,
          },
        );

        expect(replayResponse.headers()['idempotent-replay']).toBe('true');
        const replayedOrder = await readPendingOrder(
          replayResponse,
          200,
          'INVENTORY_REJECTED',
        );
        expect(replayedOrder).toEqual(createdOrder);
        expect(replayedOrder.orderId).toBe(createdOrder.orderId);
        expect(replayedOrder.createdAt).toBe(createdOrder.createdAt);
        expect(replayedOrder.status).toBe('INVENTORY_REJECTED');
        expectSafeOrderBody(replayedOrder, idempotencyKey, [
          creationCorrelationId,
          replayCorrelationId,
          'INVENTORY_ITEM_NOT_FOUND',
        ]);

        const [
          orderCountAfterReplay,
          orderRowsAfterReplay,
          reservationsByOrderAfterReplay,
          productCountAfterReplay,
          reservationsBySkuAfterReplay,
        ] = await Promise.all([
          countOrdersByIdempotencyKey(idempotencyKey),
          readOrderById(createdOrder.orderId),
          readInventoryReservationsByOrderId(createdOrder.orderId),
          countInventoryProductsBySku(missingSku),
          countInventoryReservationsBySku(missingSku),
        ]);

        expect(orderCountAfterReplay).toBe(1);
        expect(orderRowsAfterReplay).toHaveLength(1);
        expect(orderRowsAfterReplay[0]).toMatchObject({
          orderId: createdOrder.orderId,
          status: 'INVENTORY_REJECTED',
          inventoryReservationId: null,
          paymentId: null,
          failureCode: 'INVENTORY_ITEM_NOT_FOUND',
        });
        expect(orderRowsAfterReplay[0]?.updatedAt.toISOString()).toBe(
          createdUpdatedAt,
        );
        expect(reservationsByOrderAfterReplay).toHaveLength(0);
        expect(productCountAfterReplay).toBe(0);
        expect(reservationsBySkuAfterReplay).toBe(0);
      } finally {
        await cleanupOrderByIdempotencyKey(idempotencyKey);

        const [remainingOrders, remainingProducts, remainingReservations] =
          await Promise.all([
            countOrdersByIdempotencyKey(idempotencyKey),
            countInventoryProductsBySku(missingSku),
            countInventoryReservationsBySku(missingSku),
          ]);

        expect(remainingOrders).toBe(0);
        expect(remainingProducts).toBe(0);
        expect(remainingReservations).toBe(0);
      }
    });

    test('creates an inventory-rejected order when stock is insufficient', async ({
      request,
    }) => {
      const fixture = orderInventoryFixtures.insufficientStock;
      const requestedQuantity = 3;
      const idempotencyKey = `order-rejection-insufficient-${randomUUID()}`;
      const creationCorrelationId = `order-rejection-insufficient-create-${randomUUID()}`;
      const replayCorrelationId = `order-rejection-insufficient-replay-${randomUUID()}`;
      const requestBody: OrderRequestBody = {
        sku: fixture.sku,
        quantity: requestedQuantity,
        amountInCents: 5990,
        currency: 'BRL',
        paymentToken: 'tok_approved',
      };

      try {
        const [initialProduct, initialReservations, initialOrders] =
          await Promise.all([
            readInventoryProduct(fixture.sku),
            countInventoryReservationsBySku(fixture.sku),
            countOrdersByIdempotencyKey(idempotencyKey),
          ]);

        expect(initialProduct).toEqual({
          sku: fixture.sku,
          totalQuantity: fixture.totalQuantity,
          reservedQuantity: 0,
          availableQuantity: fixture.totalQuantity,
        });
        expect(requestedQuantity).toBeGreaterThan(
          initialProduct?.availableQuantity ?? -1,
        );
        expect(initialReservations).toBe(0);
        expect(initialOrders).toBe(0);

        const creationResponse = await request.post(
          'http://127.0.0.1:3001/orders',
          {
            headers: {
              'Idempotency-Key': idempotencyKey,
              'X-Correlation-Id': creationCorrelationId,
            },
            data: requestBody,
          },
        );

        expect(creationResponse.headers()).not.toHaveProperty(
          'idempotent-replay',
        );
        const createdOrder = await readPendingOrder(
          creationResponse,
          201,
          'INVENTORY_REJECTED',
        );
        expect(createdOrder).toEqual({
          orderId: createdOrder.orderId,
          sku: fixture.sku,
          quantity: requestedQuantity,
          amountInCents: 5990,
          currency: 'BRL',
          status: 'INVENTORY_REJECTED',
          createdAt: createdOrder.createdAt,
        });
        expectSafeOrderBody(createdOrder, idempotencyKey, [
          creationCorrelationId,
          'INVENTORY_INSUFFICIENT_STOCK',
        ]);

        const [
          createdOrderRows,
          reservationsByOrder,
          reservationsBySkuAfterCreation,
          productAfterCreation,
        ] = await Promise.all([
          readOrderById(createdOrder.orderId),
          readInventoryReservationsByOrderId(createdOrder.orderId),
          countInventoryReservationsBySku(fixture.sku),
          readInventoryProduct(fixture.sku),
        ]);

        expect(createdOrderRows).toHaveLength(1);
        const createdOrderRow = createdOrderRows[0];
        expect(createdOrderRow).toBeDefined();
        if (createdOrderRow === undefined) {
          throw new Error('Created Order row was not found.');
        }
        expect(createdOrderRow).toMatchObject({
          orderId: createdOrder.orderId,
          status: 'INVENTORY_REJECTED',
          inventoryReservationId: null,
          paymentId: null,
          failureCode: 'INVENTORY_INSUFFICIENT_STOCK',
        });
        expect(createdOrderRow.createdAt.toISOString()).toBe(
          createdOrder.createdAt,
        );
        const createdUpdatedAt = createdOrderRow.updatedAt.toISOString();

        expect(reservationsByOrder).toHaveLength(0);
        expect(reservationsBySkuAfterCreation).toBe(0);
        expect(productAfterCreation).toEqual(initialProduct);

        const replayResponse = await request.post(
          'http://127.0.0.1:3001/orders',
          {
            headers: {
              'Idempotency-Key': idempotencyKey,
              'X-Correlation-Id': replayCorrelationId,
            },
            data: requestBody,
          },
        );

        expect(replayResponse.headers()['idempotent-replay']).toBe('true');
        const replayedOrder = await readPendingOrder(
          replayResponse,
          200,
          'INVENTORY_REJECTED',
        );
        expect(replayedOrder).toEqual(createdOrder);
        expect(replayedOrder.orderId).toBe(createdOrder.orderId);
        expect(replayedOrder.createdAt).toBe(createdOrder.createdAt);
        expect(replayedOrder.status).toBe('INVENTORY_REJECTED');
        expectSafeOrderBody(replayedOrder, idempotencyKey, [
          creationCorrelationId,
          replayCorrelationId,
          'INVENTORY_INSUFFICIENT_STOCK',
        ]);

        const [
          orderCountAfterReplay,
          orderRowsAfterReplay,
          reservationsByOrderAfterReplay,
          reservationsBySkuAfterReplay,
          productAfterReplay,
        ] = await Promise.all([
          countOrdersByIdempotencyKey(idempotencyKey),
          readOrderById(createdOrder.orderId),
          readInventoryReservationsByOrderId(createdOrder.orderId),
          countInventoryReservationsBySku(fixture.sku),
          readInventoryProduct(fixture.sku),
        ]);

        expect(orderCountAfterReplay).toBe(1);
        expect(orderRowsAfterReplay).toHaveLength(1);
        expect(orderRowsAfterReplay[0]).toMatchObject({
          orderId: createdOrder.orderId,
          status: 'INVENTORY_REJECTED',
          inventoryReservationId: null,
          paymentId: null,
          failureCode: 'INVENTORY_INSUFFICIENT_STOCK',
        });
        expect(orderRowsAfterReplay[0]?.updatedAt.toISOString()).toBe(
          createdUpdatedAt,
        );
        expect(reservationsByOrderAfterReplay).toHaveLength(0);
        expect(reservationsBySkuAfterReplay).toBe(0);
        expect(productAfterReplay).toEqual(initialProduct);
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

  test.describe('payload validation', () => {
    test('rejects a completely missing request body', async ({ request }) => {
      const idempotencyKey = `order-${randomUUID()}`;
      const response = await request.post(
        'http://127.0.0.1:3001/orders',
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
        },
      );

      await expectOrderRequestError(
        response,
        {
          code: 'INVALID_ORDER_REQUEST',
          message: 'The order request is invalid.',
          details: {
            field: 'sku',
            reason: 'is required.',
          },
        },
        [idempotencyKey],
      );
      expect(await response.text()).not.toContain('PENDING');
    });

    test('rejects a JSON array request body', async ({ request }) => {
      const idempotencyKey = `order-${randomUUID()}`;
      const response = await request.post(
        'http://127.0.0.1:3001/orders',
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
          data: [],
        },
      );

      await expectOrderRequestError(
        response,
        {
          code: 'INVALID_ORDER_REQUEST',
          message: 'The order request is invalid.',
          details: {
            field: 'body',
            reason: 'must be a JSON object.',
          },
        },
        [idempotencyKey],
      );
      expect(await response.text()).not.toContain('PENDING');
    });

    test('rejects malformed JSON without exposing parser details', async ({
      request,
    }) => {
      const idempotencyKey = `order-${randomUUID()}`;
      const malformedBody = '{"sku":';
      const response = await request.post(
        'http://127.0.0.1:3001/orders',
        {
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
          data: malformedBody,
        },
      );

      await expectOrderRequestError(
        response,
        {
          code: 'INVALID_ORDER_REQUEST',
          message: 'The order request is invalid.',
          details: {
            field: 'body',
            reason: 'must contain valid JSON.',
          },
        },
        [idempotencyKey, malformedBody],
      );

      const responseText = await response.text();
      expect(responseText).not.toContain('PENDING');
      expect(responseText).not.toMatch(
        /SyntaxError|Unexpected token|JSON at position|body-parser|express[\\/]|node_modules|services[\\/]|[A-Z]:\\/i,
      );
    });

    test('rejects a raw body with a text/plain Content-Type', async ({
      request,
    }) => {
      const idempotencyKey = `order-${randomUUID()}`;
      const rawBody = 'unexpected order body';
      const response = await request.post(
        'http://127.0.0.1:3001/orders',
        {
          headers: {
            'Content-Type': 'text/plain',
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
          data: rawBody,
        },
      );

      await expectOrderRequestError(
        response,
        {
          code: 'INVALID_ORDER_REQUEST',
          message: 'The order request is invalid.',
          details: {
            field: 'sku',
            reason: 'is required.',
          },
        },
        [idempotencyKey, rawBody],
      );
      expect(await response.text()).not.toContain('PENDING');
    });

    test('rejects a raw body without an application/json Content-Type', async ({
      request,
    }) => {
      const idempotencyKey = `order-${randomUUID()}`;
      const rawBody = 'unexpected order body';
      const response = await request.post(
        'http://127.0.0.1:3001/orders',
        {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': `correlation-${randomUUID()}`,
          },
          data: rawBody,
        },
      );

      await expectOrderRequestError(
        response,
        {
          code: 'INVALID_ORDER_REQUEST',
          message: 'The order request is invalid.',
          details: {
            field: 'sku',
            reason: 'is required.',
          },
        },
        [idempotencyKey, rawBody],
      );
      expect(await response.text()).not.toContain('PENDING');
    });
  });

  test.describe('concurrent creation', () => {
    test('creates one order when concurrent requests use the same idempotency key', async ({
      request,
    }) => {
      const idempotencyKey = `order-${randomUUID()}`;
      const requestBody: OrderRequestBody = {
        sku: 'BOOK-001',
        quantity: 3,
        amountInCents: 7990,
        currency: 'BRL',
        paymentToken: 'tok_approved',
      };
      const firstCorrelationId = `correlation-${randomUUID()}`;
      const secondCorrelationId = `correlation-${randomUUID()}`;

      const responses = await Promise.all([
        request.post('http://127.0.0.1:3001/orders', {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': firstCorrelationId,
          },
          data: requestBody,
        }),
        request.post('http://127.0.0.1:3001/orders', {
          headers: {
            'Idempotency-Key': idempotencyKey,
            'X-Correlation-Id': secondCorrelationId,
          },
          data: requestBody,
        }),
      ]);

      expect(responses.map((response) => response.status()).sort()).toEqual([
        200, 201,
      ]);
      expect(
        responses.filter(
          (response) =>
            response.headers()['idempotent-replay'] === 'true',
        ),
      ).toHaveLength(1);

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
      expect(replayResponse.headers()['idempotent-replay']).toBe('true');

      const createdOrder = await readPendingOrder(creationResponse, 201);
      const replayedOrder = await readPendingOrder(replayResponse, 200);

      expect(createdOrder).toEqual({
        orderId: createdOrder.orderId,
        sku: 'BOOK-001',
        quantity: 3,
        amountInCents: 7990,
        currency: 'BRL',
        status: 'PENDING',
        createdAt: createdOrder.createdAt,
      });
      expect(replayedOrder).toEqual(createdOrder);
      expect(replayedOrder.orderId).toBe(createdOrder.orderId);
      expect(replayedOrder.createdAt).toBe(createdOrder.createdAt);
      expect(replayedOrder.status).toBe('PENDING');
      expectSafeOrderBody(createdOrder, idempotencyKey);
      expectSafeOrderBody(replayedOrder, idempotencyKey);

      await expectOriginalOrderReplay(
        request,
        idempotencyKey,
        requestBody,
        createdOrder,
      );
    });
  });
});
