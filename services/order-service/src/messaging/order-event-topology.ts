import type { Channel } from 'amqplib';

import type { OrderEventType } from '../events/order-event.js';

export const notificationQueue = 'notification.order-events';
export const notificationDeadLetterExchange = 'order.events.dlx';
export const notificationDeadLetterQueue = 'notification.order-events.dlq';
export const notificationDeadLetterRoutingKey =
  'notification.order-events.dlq';

export const orderEventRoutingKeys: Readonly<
  Record<OrderEventType, string>
> = {
  ORDER_CONFIRMED: 'order.confirmed',
  ORDER_INVENTORY_REJECTED: 'order.inventory_rejected',
  ORDER_PAYMENT_DECLINED: 'order.payment_declined',
  ORDER_COMPENSATION_FAILED: 'order.compensation_failed',
};

export async function assertOrderEventTopology(
  channel: Channel,
  exchange: string,
): Promise<void> {
  await channel.assertExchange(exchange, 'topic', { durable: true });
  await channel.assertExchange(notificationDeadLetterExchange, 'topic', {
    durable: true,
  });
  await channel.assertQueue(notificationDeadLetterQueue, { durable: true });
  await channel.bindQueue(
    notificationDeadLetterQueue,
    notificationDeadLetterExchange,
    notificationDeadLetterRoutingKey,
  );
  await channel.assertQueue(notificationQueue, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': notificationDeadLetterExchange,
      'x-dead-letter-routing-key': notificationDeadLetterRoutingKey,
    },
  });

  await Promise.all(
    Object.values(orderEventRoutingKeys).map((routingKey) =>
      channel.bindQueue(notificationQueue, exchange, routingKey),
    ),
  );
}
