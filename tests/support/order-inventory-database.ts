import {
  queryInventoryDatabase,
  queryOrderDatabase,
} from './database.js';
import { cleanupPaymentsByOrderIds } from './order-payment-database.js';
import { cleanupNotificationsByOrderIds } from './notification-database.js';

interface CountRow {
  count: number;
}

export interface InventoryProductRow {
  sku: string;
  totalQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
}

export interface OrderDatabaseRow {
  orderId: string;
  sku: string;
  quantity: number;
  amount: number;
  currency: string;
  status: string;
  inventoryReservationId: string | null;
  paymentId: string | null;
  failureCode: string | null;
  idempotencyKey: string;
  requestFingerprint: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface InventoryReservationRow {
  reservationId: string;
  orderId: string;
  sku: string;
  quantity: number;
  status: string;
  releaseIdempotencyKey: string | null;
  releaseRequestFingerprint: string | null;
  releasedAt: Date | null;
}

export async function readInventoryProduct(
  sku: string,
): Promise<InventoryProductRow | null> {
  const rows = await queryInventoryDatabase<InventoryProductRow>(
    `SELECT
       sku,
       total_quantity AS "totalQuantity",
       reserved_quantity AS "reservedQuantity",
       total_quantity - reserved_quantity AS "availableQuantity"
     FROM products
     WHERE sku = $1`,
    [sku],
  );

  return rows[0] ?? null;
}

export async function countInventoryProductsBySku(
  sku: string,
): Promise<number> {
  const rows = await queryInventoryDatabase<CountRow>(
    `SELECT COUNT(*)::integer AS count
     FROM products
     WHERE sku = $1`,
    [sku],
  );

  return rows[0]?.count ?? -1;
}

export async function readOrderById(
  orderId: string,
): Promise<OrderDatabaseRow[]> {
  return queryOrderDatabase<OrderDatabaseRow>(
    `SELECT
       order_id AS "orderId",
       sku,
       quantity,
       amount,
       currency,
       status,
       inventory_reservation_id AS "inventoryReservationId",
       payment_id AS "paymentId",
       failure_code AS "failureCode",
       idempotency_key AS "idempotencyKey",
       request_fingerprint AS "requestFingerprint",
       created_at AS "createdAt",
       updated_at AS "updatedAt"
     FROM orders
     WHERE order_id = $1`,
    [orderId],
  );
}

export async function readOrderByIdempotencyKey(
  idempotencyKey: string,
): Promise<OrderDatabaseRow[]> {
  return queryOrderDatabase<OrderDatabaseRow>(
    `SELECT
       order_id AS "orderId",
       sku,
       quantity,
       amount,
       currency,
       status,
       inventory_reservation_id AS "inventoryReservationId",
       payment_id AS "paymentId",
       failure_code AS "failureCode",
       idempotency_key AS "idempotencyKey",
       request_fingerprint AS "requestFingerprint",
       created_at AS "createdAt",
       updated_at AS "updatedAt"
     FROM orders
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
}

export async function readInventoryReservationsByOrderId(
  orderId: string,
): Promise<InventoryReservationRow[]> {
  return queryInventoryDatabase<InventoryReservationRow>(
    `SELECT
       reservation_id AS "reservationId",
       order_id AS "orderId",
       sku,
       quantity,
       status,
       release_idempotency_key AS "releaseIdempotencyKey",
       release_request_fingerprint AS "releaseRequestFingerprint",
       released_at AS "releasedAt"
     FROM inventory_reservations
     WHERE order_id = $1`,
    [orderId],
  );
}

export async function countOrdersByIdempotencyKey(
  idempotencyKey: string,
): Promise<number> {
  const rows = await queryOrderDatabase<CountRow>(
    `SELECT COUNT(*)::integer AS count
     FROM orders
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );

  return rows[0]?.count ?? -1;
}

export async function countInventoryReservationsBySku(
  sku: string,
): Promise<number> {
  const rows = await queryInventoryDatabase<CountRow>(
    `SELECT COUNT(*)::integer AS count
     FROM inventory_reservations
     WHERE sku = $1`,
    [sku],
  );

  return rows[0]?.count ?? -1;
}

export async function cleanupOrderByIdempotencyKey(
  idempotencyKey: string,
): Promise<void> {
  const orders = await queryOrderDatabase<{ orderId: string }>(
    `SELECT order_id AS "orderId"
     FROM orders
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  await Promise.all([
    cleanupPaymentsByOrderIds(orders.map((order) => order.orderId)),
    cleanupNotificationsByOrderIds(orders.map((order) => order.orderId)),
    queryOrderDatabase(
      `DELETE FROM orders
       WHERE idempotency_key = $1`,
      [idempotencyKey],
    ),
  ]);
}

export async function cleanupOrderInventoryFixture({
  idempotencyKey,
  sku,
  totalQuantity,
}: {
  idempotencyKey: string;
  sku: string;
  totalQuantity: number;
}): Promise<void> {
  const orders = await queryOrderDatabase<{ orderId: string }>(
    `SELECT order_id AS "orderId"
     FROM orders
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );

  await Promise.all([
    cleanupPaymentsByOrderIds(orders.map((order) => order.orderId)),
    cleanupNotificationsByOrderIds(orders.map((order) => order.orderId)),
    queryOrderDatabase(
      `DELETE FROM orders
       WHERE idempotency_key = $1`,
      [idempotencyKey],
    ),
    queryInventoryDatabase(
      `WITH deleted_reservations AS (
         DELETE FROM inventory_reservations
         WHERE sku = $1
       )
       UPDATE products
       SET total_quantity = $2,
           reserved_quantity = 0,
           updated_at = CURRENT_TIMESTAMP
       WHERE sku = $1`,
      [sku, totalQuantity],
    ),
  ]);
}
