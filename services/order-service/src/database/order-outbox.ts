import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import {
  eventTypeByStatus,
  type OrderEventType,
  type OrderEventV1,
  type TerminalOrderStatus,
} from '../events/order-event.js';
import { orderDatabasePool } from './pool.js';

export interface TerminalOrderEventInput {
  orderId: string;
  status: TerminalOrderStatus;
  sku: string;
  quantity: number;
  amountInCents: number;
  currency: 'BRL';
  failureCode: string | null;
}

export interface PendingOrderOutboxEvent {
  eventId: string;
  aggregateId: string;
  eventType: OrderEventType;
  eventVersion: 1;
  payload: OrderEventV1;
  correlationId: string;
  createdAt: Date;
  publishAttempts: number;
}

export type OutboxPublishFailure =
  | 'BROKER_UNAVAILABLE'
  | 'PUBLISH_FAILED'
  | 'UNROUTABLE_MESSAGE';

export async function insertTerminalOrderEvent(
  client: PoolClient,
  order: TerminalOrderEventInput,
  correlationId: string,
): Promise<OrderEventV1> {
  const eventId = randomUUID();
  const occurredAt = new Date().toISOString();
  const eventType = eventTypeByStatus[order.status];
  const payload: OrderEventV1 = {
    eventId,
    eventType,
    eventVersion: 1,
    occurredAt,
    correlationId,
    orderId: order.orderId,
    data: {
      status: order.status,
      sku: order.sku,
      quantity: order.quantity,
      amountInCents: order.amountInCents,
      currency: order.currency,
      failureCode: order.failureCode,
    },
  };

  await client.query(
    `INSERT INTO order_outbox_events (
       event_id,
       aggregate_id,
       event_type,
       event_version,
       payload,
       correlation_id,
       created_at
     )
     VALUES ($1, $2, $3, 1, $4::jsonb, $5, $6)`,
    [
      eventId,
      order.orderId,
      eventType,
      JSON.stringify(payload),
      correlationId,
      occurredAt,
    ],
  );

  return payload;
}

export async function readPendingOrderOutboxEvents(
  limit: number,
): Promise<PendingOrderOutboxEvent[]> {
  const result = await orderDatabasePool.query<PendingOrderOutboxEvent>(
    `SELECT
       event_id AS "eventId",
       aggregate_id AS "aggregateId",
       event_type AS "eventType",
       event_version AS "eventVersion",
       payload,
       correlation_id AS "correlationId",
       created_at AS "createdAt",
       publish_attempts AS "publishAttempts"
     FROM order_outbox_events
     WHERE published_at IS NULL
     ORDER BY created_at ASC, event_id ASC
     LIMIT $1`,
    [limit],
  );

  return result.rows;
}

export async function markOrderOutboxPublished(eventId: string): Promise<void> {
  await orderDatabasePool.query(
    `UPDATE order_outbox_events
     SET published_at = CURRENT_TIMESTAMP,
         last_error = NULL
     WHERE event_id = $1
       AND published_at IS NULL`,
    [eventId],
  );
}

export async function markOrderOutboxPublishFailure(
  eventId: string,
  failure: OutboxPublishFailure,
): Promise<void> {
  await orderDatabasePool.query(
    `UPDATE order_outbox_events
     SET publish_attempts = publish_attempts + 1,
         last_error = $2
     WHERE event_id = $1
       AND published_at IS NULL`,
    [eventId, failure],
  );
}
