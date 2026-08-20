import { queryNotificationDatabase } from './database.js';

export interface NotificationDatabaseRow {
  notificationId: string;
  eventId: string;
  orderId: string;
  eventType: string;
  eventVersion: number;
  orderStatus: string;
  failureCode: string | null;
  correlationId: string;
  message: string;
  createdAt: Date;
}

export async function readNotificationsByOrderId(
  orderId: string,
): Promise<NotificationDatabaseRow[]> {
  return queryNotificationDatabase<NotificationDatabaseRow>(
    `SELECT
       notification_id AS "notificationId",
       event_id AS "eventId",
       order_id AS "orderId",
       event_type AS "eventType",
       event_version AS "eventVersion",
       order_status AS "orderStatus",
       failure_code AS "failureCode",
       correlation_id AS "correlationId",
       message,
       created_at AS "createdAt"
     FROM notifications
     WHERE order_id = $1
     ORDER BY created_at`,
    [orderId],
  );
}

export async function readNotificationsByEventId(
  eventId: string,
): Promise<NotificationDatabaseRow[]> {
  return queryNotificationDatabase<NotificationDatabaseRow>(
    `SELECT
       notification_id AS "notificationId",
       event_id AS "eventId",
       order_id AS "orderId",
       event_type AS "eventType",
       event_version AS "eventVersion",
       order_status AS "orderStatus",
       failure_code AS "failureCode",
       correlation_id AS "correlationId",
       message,
       created_at AS "createdAt"
     FROM notifications
     WHERE event_id = $1`,
    [eventId],
  );
}

export async function cleanupNotificationsByOrderIds(
  orderIds: readonly string[],
): Promise<void> {
  if (orderIds.length === 0) return;
  await queryNotificationDatabase(
    `DELETE FROM notifications
     WHERE order_id = ANY($1::uuid[])`,
    [[...orderIds]],
  );
}
