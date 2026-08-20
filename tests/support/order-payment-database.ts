import { queryPaymentDatabase } from './database.js';

interface CountRow {
  count: number;
}

export interface PaymentDatabaseRow {
  paymentId: string;
  orderId: string;
  amountInCents: number;
  currency: string;
  status: string;
  declineCode: string | null;
  idempotencyKey: string;
  requestFingerprint: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function readPaymentsByOrderId(
  orderId: string,
): Promise<PaymentDatabaseRow[]> {
  return queryPaymentDatabase<PaymentDatabaseRow>(
    `SELECT
       payment_id AS "paymentId",
       order_id AS "orderId",
       amount_in_cents AS "amountInCents",
       currency,
       status,
       decline_code AS "declineCode",
       idempotency_key AS "idempotencyKey",
       request_fingerprint AS "requestFingerprint",
       created_at AS "createdAt",
       updated_at AS "updatedAt"
     FROM payments
     WHERE order_id = $1`,
    [orderId],
  );
}

export async function countPaymentsByOrderId(orderId: string): Promise<number> {
  const rows = await queryPaymentDatabase<CountRow>(
    `SELECT COUNT(*)::integer AS count
     FROM payments
     WHERE order_id = $1`,
    [orderId],
  );

  return rows[0]?.count ?? -1;
}

export async function cleanupPaymentsByOrderIds(
  orderIds: readonly string[],
): Promise<void> {
  if (orderIds.length === 0) return;

  await queryPaymentDatabase(
    `DELETE FROM payments
     WHERE order_id = ANY($1::uuid[])`,
    [[...orderIds]],
  );
}
