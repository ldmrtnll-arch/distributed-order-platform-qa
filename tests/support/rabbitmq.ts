import { connect, type Channel, type ConfirmChannel } from 'amqplib';

export const orderEventsExchange = 'order.events';
export const orderEventsDeadLetterExchange = 'order.events.dlx';
export const notificationQueue = 'notification.order-events';
export const notificationDeadLetterQueue = 'notification.order-events.dlq';
const notificationDeadLetterRoutingKey = 'notification.order-events.dlq';
const routingKeys = [
  'order.confirmed',
  'order.inventory_rejected',
  'order.payment_declined',
  'order.compensation_failed',
] as const;

function rabbitMqUrl(): string {
  return (
    process.env.RABBITMQ_URL ??
    'amqp://qa_user:qa_password@127.0.0.1:5672/qa'
  );
}

async function withChannel<T>(
  operation: (channel: Channel) => Promise<T>,
): Promise<T> {
  const connection = await connect(rabbitMqUrl());
  const channel = await connection.createChannel();
  try {
    return await operation(channel);
  } finally {
    await channel.close();
    await connection.close();
  }
}

export async function setupOrderEventTopology(): Promise<void> {
  await withChannel(async (channel) => {
    await channel.assertExchange(orderEventsExchange, 'topic', {
      durable: true,
    });
    await channel.assertExchange(orderEventsDeadLetterExchange, 'topic', {
      durable: true,
    });
    await channel.assertQueue(notificationDeadLetterQueue, { durable: true });
    await channel.bindQueue(
      notificationDeadLetterQueue,
      orderEventsDeadLetterExchange,
      notificationDeadLetterRoutingKey,
    );
    await channel.assertQueue(notificationQueue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': orderEventsDeadLetterExchange,
        'x-dead-letter-routing-key': notificationDeadLetterRoutingKey,
      },
    });
    await Promise.all(
      routingKeys.map((routingKey) =>
        channel.bindQueue(notificationQueue, orderEventsExchange, routingKey),
      ),
    );
  });
}

export async function purgeOrderEventQueues(): Promise<void> {
  await withChannel(async (channel) => {
    await channel.purgeQueue(notificationQueue);
    await channel.purgeQueue(notificationDeadLetterQueue);
  });
}

export async function getQueueMessageCount(queue: string): Promise<number> {
  return withChannel(async (channel) => {
    const result = await channel.checkQueue(queue);
    return result.messageCount;
  });
}

export async function publishOrderEvent(
  routingKey: string,
  payload: unknown,
  options: { correlationId?: string; messageId?: string } = {},
): Promise<void> {
  await publishBuffer(
    routingKey,
    Buffer.from(JSON.stringify(payload)),
    options,
  );
}

export async function publishRawOrderEvent(
  routingKey: string,
  payload: string,
): Promise<void> {
  await publishBuffer(routingKey, Buffer.from(payload), {});
}

async function publishBuffer(
  routingKey: string,
  payload: Buffer,
  options: { correlationId?: string; messageId?: string },
): Promise<void> {
  const connection = await connect(rabbitMqUrl());
  const channel: ConfirmChannel = await connection.createConfirmChannel();
  try {
    channel.publish(orderEventsExchange, routingKey, payload, {
      persistent: true,
      contentType: 'application/json',
      ...(options.correlationId === undefined
        ? {}
        : { correlationId: options.correlationId }),
      ...(options.messageId === undefined
        ? {}
        : { messageId: options.messageId }),
    });
    await channel.waitForConfirms();
  } finally {
    await channel.close();
    await connection.close();
  }
}
