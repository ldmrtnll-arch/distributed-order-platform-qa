import { queryOrderDatabase } from './database.js';

export interface OrderOutboxRow {
  eventId: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: unknown;
  correlationId: string;
  createdAt: Date;
  publishedAt: Date | null;
  publishAttempts: number;
  lastError: string | null;
}

export async function readOrderOutboxByOrderId(
  orderId: string,
): Promise<OrderOutboxRow[]> {
  return queryOrderDatabase<OrderOutboxRow>(
    `SELECT
       event_id AS "eventId",
       aggregate_id AS "aggregateId",
       event_type AS "eventType",
       event_version AS "eventVersion",
       payload,
       correlation_id AS "correlationId",
       created_at AS "createdAt",
       published_at AS "publishedAt",
       publish_attempts AS "publishAttempts",
       last_error AS "lastError"
     FROM order_outbox_events
     WHERE aggregate_id = $1
     ORDER BY created_at`,
    [orderId],
  );
}

export async function cleanupOrderOutboxByOrderIds(
  orderIds: readonly string[],
): Promise<void> {
  if (orderIds.length === 0) return;
  await queryOrderDatabase(
    `DELETE FROM order_outbox_events
     WHERE aggregate_id = ANY($1::uuid[])`,
    [[...orderIds]],
  );
}
