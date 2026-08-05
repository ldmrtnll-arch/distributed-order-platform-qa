import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { inventoryDatabasePool } from './pool.js';

export interface ReservationOperation {
  idempotencyKey: string;
  orderId: string;
  sku: string;
  quantity: number;
}

export interface Reservation {
  reservationId: string;
  orderId: string;
  sku: string;
  quantity: number;
  status: 'RESERVED';
  createdAt: string;
}

export type CreateReservationResult =
  | { kind: 'created'; reservation: Reservation }
  | { kind: 'replayed'; reservation: Reservation }
  | { kind: 'idempotency-conflict' }
  | { kind: 'item-not-found' }
  | { kind: 'insufficient-stock'; availableQuantity: number };

interface ReservationRow {
  reservationId: string;
  orderId: string;
  sku: string;
  quantity: number;
  status: 'RESERVED';
  requestFingerprint: string;
  createdAt: Date;
}

interface ProductQuantityRow {
  totalQuantity: number;
  reservedQuantity: number;
}

function createRequestFingerprint(operation: ReservationOperation): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        operation.orderId,
        operation.sku,
        operation.quantity,
      ]),
    )
    .digest('hex');
}

function mapReservation(row: ReservationRow): Reservation {
  return {
    reservationId: row.reservationId,
    orderId: row.orderId,
    sku: row.sku,
    quantity: row.quantity,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

async function rollbackTransaction(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original database error.
  }
}

export async function createInventoryReservation(
  operation: ReservationOperation,
): Promise<CreateReservationResult> {
  const client = await inventoryDatabasePool.connect();
  const requestFingerprint = createRequestFingerprint(operation);

  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [operation.idempotencyKey],
    );

    const existingReservationResult = await client.query<ReservationRow>(
      `SELECT
         reservation_id AS "reservationId",
         order_id AS "orderId",
         sku,
         quantity,
         status,
         request_fingerprint AS "requestFingerprint",
         created_at AS "createdAt"
       FROM inventory_reservations
       WHERE idempotency_key = $1`,
      [operation.idempotencyKey],
    );
    const existingReservation = existingReservationResult.rows[0];

    if (existingReservation !== undefined) {
      await client.query('COMMIT');

      if (existingReservation.requestFingerprint !== requestFingerprint) {
        return { kind: 'idempotency-conflict' };
      }

      return {
        kind: 'replayed',
        reservation: mapReservation(existingReservation),
      };
    }

    const productResult = await client.query<ProductQuantityRow>(
      `SELECT
         total_quantity AS "totalQuantity",
         reserved_quantity AS "reservedQuantity"
       FROM products
       WHERE sku = $1
       FOR UPDATE`,
      [operation.sku],
    );
    const product = productResult.rows[0];

    if (product === undefined) {
      await client.query('ROLLBACK');
      return { kind: 'item-not-found' };
    }

    const availableQuantity = product.totalQuantity - product.reservedQuantity;

    if (availableQuantity < operation.quantity) {
      await client.query('ROLLBACK');
      return { kind: 'insufficient-stock', availableQuantity };
    }

    const reservationId = randomUUID();
    const reservationResult = await client.query<ReservationRow>(
      `INSERT INTO inventory_reservations (
         reservation_id,
         order_id,
         sku,
         quantity,
         status,
         idempotency_key,
         request_fingerprint
       )
       VALUES ($1, $2, $3, $4, 'RESERVED', $5, $6)
       RETURNING
         reservation_id AS "reservationId",
         order_id AS "orderId",
         sku,
         quantity,
         status,
         request_fingerprint AS "requestFingerprint",
         created_at AS "createdAt"`,
      [
        reservationId,
        operation.orderId,
        operation.sku,
        operation.quantity,
        operation.idempotencyKey,
        requestFingerprint,
      ],
    );
    const createdReservation = reservationResult.rows[0];

    if (createdReservation === undefined) {
      throw new Error('Reservation insert returned no row.');
    }

    await client.query(
      `UPDATE products
       SET reserved_quantity = reserved_quantity + $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE sku = $2`,
      [operation.quantity, operation.sku],
    );
    await client.query('COMMIT');

    return {
      kind: 'created',
      reservation: mapReservation(createdReservation),
    };
  } catch (error) {
    await rollbackTransaction(client);
    throw error;
  } finally {
    client.release();
  }
}
