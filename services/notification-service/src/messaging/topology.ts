import type { Channel } from 'amqplib';

export const notificationQueue = 'notification.order-events';
export const notificationDeadLetterExchange = 'order.events.dlx';
export const notificationDeadLetterQueue = 'notification.order-events.dlq';
export const notificationDeadLetterRoutingKey =
  'notification.order-events.dlq';
export const orderEventRoutingKeys = [
  'order.confirmed',
  'order.inventory_rejected',
  'order.payment_declined',
  'order.compensation_failed',
] as const;

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
    orderEventRoutingKeys.map((routingKey) =>
      channel.bindQueue(notificationQueue, exchange, routingKey),
    ),
  );
}
