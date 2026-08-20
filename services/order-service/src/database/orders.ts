import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type { OrderRequest } from '../validation/order.js';
import type { InventoryRejectionCode } from '../clients/inventory-client.js';
import type { TerminalOrderStatus } from '../events/order-event.js';
import { insertTerminalOrderEvent } from './order-outbox.js';
import { orderDatabasePool } from './pool.js';

export interface Order {
  orderId: string;
  sku: string;
  quantity: number;
  amountInCents: number;
  currency: 'BRL';
  status:
    | 'PENDING'
    | 'INVENTORY_RESERVED'
    | 'INVENTORY_REJECTED'
    | 'CONFIRMED'
    | 'PAYMENT_DECLINED'
    | 'COMPENSATION_FAILED';
  createdAt: string;
}

export interface OrderState {
  order: Order;
  inventoryReservationId: string | null;
  paymentId: string | null;
  failureCode: string | null;
}

export type CreateOrderResult =
  | { kind: 'created'; state: OrderState }
  | { kind: 'existing'; state: OrderState }
  | { kind: 'idempotency-conflict' };

export type OrderTransitionResult =
  | { kind: 'updated'; state: OrderState }
  | { kind: 'already-updated'; state: OrderState }
  | { kind: 'state-conflict' };

interface OrderRow {
  orderId: string;
  sku: string;
  quantity: number;
  amountInCents: number;
  currency: 'BRL';
  status: Order['status'];
  inventoryReservationId: string | null;
  paymentId: string | null;
  failureCode: string | null;
  requestFingerprint: string;
  createdAt: Date;
}

function createRequestFingerprint(request: OrderRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.sku,
        request.quantity,
        request.amountInCents,
        request.currency,
        request.paymentToken,
      ]),
    )
    .digest('hex');
}

function mapOrder(row: OrderRow): Order {
  return {
    orderId: row.orderId,
    sku: row.sku,
    quantity: row.quantity,
    amountInCents: row.amountInCents,
    currency: row.currency,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapOrderState(row: OrderRow): OrderState {
  return {
    order: mapOrder(row),
    inventoryReservationId: row.inventoryReservationId,
    paymentId: row.paymentId,
    failureCode: row.failureCode,
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original database error.
  }
}

export async function createOrder(
  request: OrderRequest,
  idempotencyKey: string,
): Promise<CreateOrderResult> {
  const client = await orderDatabasePool.connect();
  const requestFingerprint = createRequestFingerprint(request);

  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [idempotencyKey],
    );
    const existingResult = await client.query<OrderRow>(
      `SELECT
         order_id AS "orderId",
         sku,
         quantity,
         amount AS "amountInCents",
         currency,
         status,
         inventory_reservation_id AS "inventoryReservationId",
         payment_id AS "paymentId",
         failure_code AS "failureCode",
         request_fingerprint AS "requestFingerprint",
         created_at AS "createdAt"
       FROM orders
       WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const existingOrder = existingResult.rows[0];

    if (existingOrder !== undefined) {
      await client.query('COMMIT');
      if (existingOrder.requestFingerprint !== requestFingerprint) {
        return { kind: 'idempotency-conflict' };
      }
      return { kind: 'existing', state: mapOrderState(existingOrder) };
    }

    const orderId = randomUUID();
    const insertedResult = await client.query<OrderRow>(
      `INSERT INTO orders (
         order_id,
         sku,
         quantity,
         amount,
         currency,
         status,
         idempotency_key,
         request_fingerprint
       )
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7)
       RETURNING
         order_id AS "orderId",
         sku,
         quantity,
         amount AS "amountInCents",
         currency,
         status,
         inventory_reservation_id AS "inventoryReservationId",
         payment_id AS "paymentId",
         failure_code AS "failureCode",
         request_fingerprint AS "requestFingerprint",
         created_at AS "createdAt"`,
      [
        orderId,
        request.sku,
        request.quantity,
        request.amountInCents,
        request.currency,
        idempotencyKey,
        requestFingerprint,
      ],
    );
    const insertedOrder = insertedResult.rows[0];
    if (insertedOrder === undefined) {
      throw new Error('Order insert returned no row.');
    }

    await client.query('COMMIT');
    return { kind: 'created', state: mapOrderState(insertedOrder) };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function markInventoryReserved(
  orderId: string,
  reservationId: string,
): Promise<OrderTransitionResult> {
  const updatedResult = await orderDatabasePool.query<OrderRow>(
    `UPDATE orders
     SET status = 'INVENTORY_RESERVED',
         inventory_reservation_id = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE order_id = $1
       AND status = 'PENDING'
     RETURNING
       order_id AS "orderId",
       sku,
       quantity,
       amount AS "amountInCents",
       currency,
       status,
       inventory_reservation_id AS "inventoryReservationId",
       payment_id AS "paymentId",
       failure_code AS "failureCode",
       request_fingerprint AS "requestFingerprint",
       created_at AS "createdAt"`,
    [orderId, reservationId],
  );
  const updatedOrder = updatedResult.rows[0];

  if (updatedOrder !== undefined) {
    return { kind: 'updated', state: mapOrderState(updatedOrder) };
  }

  const currentResult = await orderDatabasePool.query<OrderRow>(
    `SELECT
       order_id AS "orderId",
       sku,
       quantity,
       amount AS "amountInCents",
       currency,
       status,
       inventory_reservation_id AS "inventoryReservationId",
       payment_id AS "paymentId",
       failure_code AS "failureCode",
       request_fingerprint AS "requestFingerprint",
       created_at AS "createdAt"
     FROM orders
     WHERE order_id = $1`,
    [orderId],
  );
  const currentOrder = currentResult.rows[0];

  if (
    currentOrder !== undefined &&
    currentOrder.status !== 'PENDING' &&
    currentOrder.status !== 'INVENTORY_REJECTED' &&
    currentOrder.inventoryReservationId === reservationId
  ) {
    return { kind: 'already-updated', state: mapOrderState(currentOrder) };
  }

  return { kind: 'state-conflict' };
}

export async function markInventoryRejected(
  orderId: string,
  failureCode: InventoryRejectionCode,
  correlationId: string,
): Promise<OrderTransitionResult> {
  return transitionToTerminalState({
    orderId,
    targetStatus: 'INVENTORY_REJECTED',
    correlationId,
    updateSql: `UPDATE orders
       SET status = 'INVENTORY_REJECTED',
           inventory_reservation_id = NULL,
           payment_id = NULL,
           failure_code = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE order_id = $1
         AND status = 'PENDING'
       RETURNING
         order_id AS "orderId",
         sku,
         quantity,
         amount AS "amountInCents",
         currency,
         status,
         inventory_reservation_id AS "inventoryReservationId",
         payment_id AS "paymentId",
         failure_code AS "failureCode",
         request_fingerprint AS "requestFingerprint",
         created_at AS "createdAt"`,
    updateParameters: [orderId, failureCode],
    isAlreadyUpdated: (state) => state.failureCode === failureCode,
  });
}

async function transitionToTerminalState({
  orderId,
  targetStatus,
  correlationId,
  updateSql,
  updateParameters,
  isAlreadyUpdated,
}: {
  orderId: string;
  targetStatus: TerminalOrderStatus;
  correlationId: string;
  updateSql: string;
  updateParameters: readonly unknown[];
  isAlreadyUpdated: (state: OrderState) => boolean;
}): Promise<OrderTransitionResult> {
  const client = await orderDatabasePool.connect();

  try {
    await client.query('BEGIN');
    const updatedResult = await client.query<OrderRow>(updateSql, [
      ...updateParameters,
    ]);
    const updatedOrder = updatedResult.rows[0];

    if (updatedOrder !== undefined) {
      await insertTerminalOrderEvent(
        client,
        {
          orderId: updatedOrder.orderId,
          status: targetStatus,
          sku: updatedOrder.sku,
          quantity: updatedOrder.quantity,
          amountInCents: updatedOrder.amountInCents,
          currency: updatedOrder.currency,
          failureCode: updatedOrder.failureCode,
        },
        correlationId,
      );
      await client.query('COMMIT');
      return { kind: 'updated', state: mapOrderState(updatedOrder) };
    }

    const currentResult = await client.query<OrderRow>(
      `SELECT
         order_id AS "orderId",
         sku,
         quantity,
         amount AS "amountInCents",
         currency,
         status,
         inventory_reservation_id AS "inventoryReservationId",
         payment_id AS "paymentId",
         failure_code AS "failureCode",
         request_fingerprint AS "requestFingerprint",
         created_at AS "createdAt"
       FROM orders
       WHERE order_id = $1`,
      [orderId],
    );
    await client.query('COMMIT');
    const currentOrder = currentResult.rows[0];
    if (currentOrder === undefined || currentOrder.status !== targetStatus) {
      return { kind: 'state-conflict' };
    }

    const state = mapOrderState(currentOrder);
    return isAlreadyUpdated(state)
      ? { kind: 'already-updated', state }
      : { kind: 'state-conflict' };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function markPaymentConfirmed(
  orderId: string,
  paymentId: string,
  correlationId: string,
): Promise<OrderTransitionResult> {
  return transitionToTerminalState({
    orderId,
    targetStatus: 'CONFIRMED',
    correlationId,
    updateSql: `UPDATE orders
       SET status = 'CONFIRMED',
           payment_id = $2,
           failure_code = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE order_id = $1
         AND status = 'INVENTORY_RESERVED'
       RETURNING
         order_id AS "orderId",
         sku,
         quantity,
         amount AS "amountInCents",
         currency,
         status,
         inventory_reservation_id AS "inventoryReservationId",
         payment_id AS "paymentId",
         failure_code AS "failureCode",
         request_fingerprint AS "requestFingerprint",
         created_at AS "createdAt"`,
    updateParameters: [orderId, paymentId],
    isAlreadyUpdated: (state) => state.paymentId === paymentId,
  });
}

export async function markPaymentDeclined(
  orderId: string,
  paymentId: string,
  failureCode: string,
  correlationId: string,
): Promise<OrderTransitionResult> {
  return transitionToTerminalState({
    orderId,
    targetStatus: 'PAYMENT_DECLINED',
    correlationId,
    updateSql: `UPDATE orders
       SET status = 'PAYMENT_DECLINED',
           payment_id = $2,
           failure_code = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE order_id = $1
         AND status = 'INVENTORY_RESERVED'
       RETURNING
         order_id AS "orderId",
         sku,
         quantity,
         amount AS "amountInCents",
         currency,
         status,
         inventory_reservation_id AS "inventoryReservationId",
         payment_id AS "paymentId",
         failure_code AS "failureCode",
         request_fingerprint AS "requestFingerprint",
         created_at AS "createdAt"`,
    updateParameters: [orderId, paymentId, failureCode],
    isAlreadyUpdated: (state) =>
      state.paymentId === paymentId && state.failureCode === failureCode,
  });
}

export async function markCompensationFailed(
  orderId: string,
  paymentId: string,
  correlationId: string,
): Promise<OrderTransitionResult> {
  const failureCode = 'INVENTORY_COMPENSATION_FAILED';
  return transitionToTerminalState({
    orderId,
    targetStatus: 'COMPENSATION_FAILED',
    correlationId,
    updateSql: `UPDATE orders
       SET status = 'COMPENSATION_FAILED',
           payment_id = $2,
           failure_code = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE order_id = $1
         AND status = 'INVENTORY_RESERVED'
       RETURNING
         order_id AS "orderId",
         sku,
         quantity,
         amount AS "amountInCents",
         currency,
         status,
         inventory_reservation_id AS "inventoryReservationId",
         payment_id AS "paymentId",
         failure_code AS "failureCode",
         request_fingerprint AS "requestFingerprint",
         created_at AS "createdAt"`,
    updateParameters: [orderId, paymentId, failureCode],
    isAlreadyUpdated: (state) =>
      state.paymentId === paymentId && state.failureCode === failureCode,
  });
}
