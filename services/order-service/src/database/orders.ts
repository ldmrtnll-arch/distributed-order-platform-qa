import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import type { OrderRequest } from '../validation/order.js';
import { orderDatabasePool } from './pool.js';

export interface Order {
  orderId: string;
  sku: string;
  quantity: number;
  amountInCents: number;
  currency: 'BRL';
  status: 'PENDING';
  createdAt: string;
}

export type CreateOrderResult =
  | { kind: 'created'; order: Order }
  | { kind: 'replayed'; order: Order }
  | { kind: 'idempotency-conflict' };

interface OrderRow {
  orderId: string;
  sku: string;
  quantity: number;
  amountInCents: number;
  currency: 'BRL';
  status: 'PENDING';
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
      return { kind: 'replayed', order: mapOrder(existingOrder) };
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
    return { kind: 'created', order: mapOrder(insertedOrder) };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}
