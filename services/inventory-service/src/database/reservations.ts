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

export interface ReleaseReservationOperation {
  idempotencyKey: string;
  reservationId: string;
}

export interface ReleasedReservation {
  reservationId: string;
  orderId: string;
  sku: string;
  quantity: number;
  status: 'RELEASED';
  releasedAt: string;
}

export type ReleaseReservationResult =
  | { kind: 'released'; reservation: ReleasedReservation }
  | { kind: 'replayed'; reservation: ReleasedReservation }
  | { kind: 'idempotency-conflict' }
  | { kind: 'reservation-not-found' }
  | { kind: 'already-released' };

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

interface ReleaseReservationRow {
  reservationId: string;
  orderId: string;
  sku: string;
  quantity: number;
  status: 'RESERVED' | 'RELEASED';
  releaseRequestFingerprint: string | null;
  releasedAt: Date | null;
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

function createReleaseFingerprint(reservationId: string): string {
  return createHash('sha256').update(reservationId).digest('hex');
}

function mapReleasedReservation(
  row: ReleaseReservationRow,
): ReleasedReservation {
  if (row.status !== 'RELEASED' || row.releasedAt === null) {
    throw new Error('Released reservation row is incomplete.');
  }

  return {
    reservationId: row.reservationId,
    orderId: row.orderId,
    sku: row.sku,
    quantity: row.quantity,
    status: row.status,
    releasedAt: row.releasedAt.toISOString(),
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

export async function releaseInventoryReservation(
  operation: ReleaseReservationOperation,
): Promise<ReleaseReservationResult> {
  const client = await inventoryDatabasePool.connect();
  const requestFingerprint = createReleaseFingerprint(operation.reservationId);

  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [operation.idempotencyKey],
    );

    const existingReleaseResult = await client.query<ReleaseReservationRow>(
      `SELECT
         reservation_id AS "reservationId",
         order_id AS "orderId",
         sku,
         quantity,
         status,
         release_request_fingerprint AS "releaseRequestFingerprint",
         released_at AS "releasedAt"
       FROM inventory_reservations
       WHERE release_idempotency_key = $1`,
      [operation.idempotencyKey],
    );
    const existingRelease = existingReleaseResult.rows[0];

    if (existingRelease !== undefined) {
      await client.query('COMMIT');

      if (existingRelease.releaseRequestFingerprint !== requestFingerprint) {
        return { kind: 'idempotency-conflict' };
      }

      return {
        kind: 'replayed',
        reservation: mapReleasedReservation(existingRelease),
      };
    }

    const reservationResult = await client.query<ReleaseReservationRow>(
      `SELECT
         reservation_id AS "reservationId",
         order_id AS "orderId",
         sku,
         quantity,
         status,
         release_request_fingerprint AS "releaseRequestFingerprint",
         released_at AS "releasedAt"
       FROM inventory_reservations
       WHERE reservation_id = $1
       FOR UPDATE`,
      [operation.reservationId],
    );
    const reservation = reservationResult.rows[0];

    if (reservation === undefined) {
      await client.query('ROLLBACK');
      return { kind: 'reservation-not-found' };
    }

    if (reservation.status === 'RELEASED') {
      await client.query('ROLLBACK');
      return { kind: 'already-released' };
    }

    await client.query(
      `SELECT sku
       FROM products
       WHERE sku = $1
       FOR UPDATE`,
      [reservation.sku],
    );

    const productUpdate = await client.query(
      `UPDATE products
       SET reserved_quantity = reserved_quantity - $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE sku = $2
         AND reserved_quantity >= $1`,
      [reservation.quantity, reservation.sku],
    );

    if (productUpdate.rowCount !== 1) {
      throw new Error('Reservation release would make stock negative.');
    }

    const releasedResult = await client.query<ReleaseReservationRow>(
      `UPDATE inventory_reservations
       SET status = 'RELEASED',
           release_idempotency_key = $1,
           release_request_fingerprint = $2,
           released_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE reservation_id = $3
       RETURNING
         reservation_id AS "reservationId",
         order_id AS "orderId",
         sku,
         quantity,
         status,
         release_request_fingerprint AS "releaseRequestFingerprint",
         released_at AS "releasedAt"`,
      [operation.idempotencyKey, requestFingerprint, operation.reservationId],
    );
    const releasedReservation = releasedResult.rows[0];

    if (releasedReservation === undefined) {
      throw new Error('Reservation release update returned no row.');
    }

    await client.query('COMMIT');
    return {
      kind: 'released',
      reservation: mapReleasedReservation(releasedReservation),
    };
  } catch (error) {
    await rollbackTransaction(client);
    throw error;
  } finally {
    client.release();
  }
}
