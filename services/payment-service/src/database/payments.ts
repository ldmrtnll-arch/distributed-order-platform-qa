import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { processPayment } from '../gateway/payment-gateway.js';
import type { PaymentRequest } from '../validation/payment.js';
import { paymentDatabasePool } from './pool.js';

export interface Payment {
  paymentId: string;
  orderId: string;
  amountInCents: number;
  currency: 'BRL';
  status: 'APPROVED' | 'DECLINED';
  declineCode?: string;
  createdAt: string;
}

export type CreatePaymentResult =
  | { kind: 'created'; payment: Payment }
  | { kind: 'replayed'; payment: Payment }
  | { kind: 'idempotency-conflict' };

interface PaymentRow {
  paymentId: string;
  orderId: string;
  amountInCents: number;
  currency: 'BRL';
  status: 'APPROVED' | 'DECLINED';
  declineCode: string | null;
  requestFingerprint: string;
  createdAt: Date;
}

function createRequestFingerprint(request: PaymentRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.orderId,
        request.amountInCents,
        request.currency,
        request.paymentToken,
      ]),
    )
    .digest('hex');
}

function mapPayment(row: PaymentRow): Payment {
  return {
    paymentId: row.paymentId,
    orderId: row.orderId,
    amountInCents: row.amountInCents,
    currency: row.currency,
    status: row.status,
    ...(row.declineCode === null
      ? {}
      : { declineCode: row.declineCode }),
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

export async function createPayment(
  request: PaymentRequest,
  idempotencyKey: string,
): Promise<CreatePaymentResult> {
  const client = await paymentDatabasePool.connect();
  const requestFingerprint = createRequestFingerprint(request);

  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [idempotencyKey],
    );

    const existingResult = await client.query<PaymentRow>(
      `SELECT
         payment_id AS "paymentId",
         order_id AS "orderId",
         amount_in_cents AS "amountInCents",
         currency,
         status,
         decline_code AS "declineCode",
         request_fingerprint AS "requestFingerprint",
         created_at AS "createdAt"
       FROM payments
       WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const existingPayment = existingResult.rows[0];

    if (existingPayment !== undefined) {
      await client.query('COMMIT');

      if (existingPayment.requestFingerprint !== requestFingerprint) {
        return { kind: 'idempotency-conflict' };
      }

      return { kind: 'replayed', payment: mapPayment(existingPayment) };
    }

    const gatewayResult = processPayment(request.paymentToken);
    const paymentId = randomUUID();
    const declineCode =
      gatewayResult.status === 'DECLINED'
        ? gatewayResult.declineCode
        : null;
    const insertResult = await client.query<PaymentRow>(
      `INSERT INTO payments (
         payment_id,
         order_id,
         amount_in_cents,
         currency,
         status,
         decline_code,
         idempotency_key,
         request_fingerprint
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING
         payment_id AS "paymentId",
         order_id AS "orderId",
         amount_in_cents AS "amountInCents",
         currency,
         status,
         decline_code AS "declineCode",
         request_fingerprint AS "requestFingerprint",
         created_at AS "createdAt"`,
      [
        paymentId,
        request.orderId,
        request.amountInCents,
        request.currency,
        gatewayResult.status,
        declineCode,
        idempotencyKey,
        requestFingerprint,
      ],
    );
    const insertedPayment = insertResult.rows[0];

    if (insertedPayment === undefined) {
      throw new Error('Payment insert returned no row.');
    }

    await client.query('COMMIT');

    return { kind: 'created', payment: mapPayment(insertedPayment) };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}
