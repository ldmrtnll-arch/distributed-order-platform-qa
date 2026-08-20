import { randomUUID } from 'node:crypto';

import type { OrderEventV1, OrderEventType } from '../events/order-event.js';
import { notificationDatabasePool } from './pool.js';

const messageByEventType: Readonly<Record<OrderEventType, string>> = {
  ORDER_CONFIRMED: 'Order confirmed.',
  ORDER_INVENTORY_REJECTED:
    'Order rejected because inventory could not be reserved.',
  ORDER_PAYMENT_DECLINED: 'Order payment was declined.',
  ORDER_COMPENSATION_FAILED:
    'Order requires manual reconciliation after compensation failure.',
};

export async function persistNotification(
  event: OrderEventV1,
): Promise<'created' | 'duplicate'> {
  const client = await notificationDatabasePool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query<{ notificationId: string }>(
      `INSERT INTO notifications (
         notification_id,
         event_id,
         order_id,
         event_type,
         event_version,
         order_status,
         failure_code,
         correlation_id,
         message
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING notification_id AS "notificationId"`,
      [
        randomUUID(),
        event.eventId,
        event.orderId,
        event.eventType,
        event.eventVersion,
        event.data.status,
        event.data.failureCode,
        event.correlationId,
        messageByEventType[event.eventType],
      ],
    );
    await client.query('COMMIT');
    return result.rows[0] === undefined ? 'duplicate' : 'created';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
