import {
  connect,
  type ChannelModel,
  type ConfirmChannel,
  type Message,
} from 'amqplib';

import { environment } from '../config/environment.js';
import {
  markOrderOutboxPublished,
  markOrderOutboxPublishFailure,
  readPendingOrderOutboxEvents,
  type OutboxPublishFailure,
  type PendingOrderOutboxEvent,
} from '../database/order-outbox.js';
import { routingKeyByEventType } from '../events/order-event.js';
import { assertOrderEventTopology } from './order-event-topology.js';

class UnroutableMessageError extends Error {
  constructor() {
    super('Order event was not routed.');
    this.name = 'UnroutableMessageError';
  }
}

export interface OrderEventPublisher {
  stop: () => Promise<void>;
}

class Publisher implements OrderEventPublisher {
  private connection: ChannelModel | undefined;
  private channel: ConfirmChannel | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private polling = false;

  start(): void {
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;

    while (this.polling) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await this.closeBrokerResources();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;

    try {
      const events = await readPendingOrderOutboxEvents(20);
      for (const event of events) {
        if (this.stopped) break;
        const published = await this.publishEvent(event);
        if (!published) break;
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'order-service',
          operation: 'publish-order-events',
          message: 'Order outbox polling failed',
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    } finally {
      this.polling = false;
      this.schedule(environment.orderEventPublishIntervalMs);
    }
  }

  private async publishEvent(
    event: PendingOrderOutboxEvent,
  ): Promise<boolean> {
    let failure: OutboxPublishFailure = 'PUBLISH_FAILED';

    try {
      const channel = await this.ensureChannel();
      await this.publishWithConfirm(channel, event);
      await markOrderOutboxPublished(event.eventId);
      console.log(
        JSON.stringify({
          level: 'info',
          service: 'order-service',
          operation: 'publish-order-event',
          message: 'Order event published',
          eventId: event.eventId,
          eventType: event.eventType,
          orderId: event.aggregateId,
          correlationId: event.correlationId,
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof UnroutableMessageError) {
        failure = 'UNROUTABLE_MESSAGE';
      } else if (this.channel === undefined) {
        failure = 'BROKER_UNAVAILABLE';
      }

      await markOrderOutboxPublishFailure(event.eventId, failure);
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'order-service',
          operation: 'publish-order-event',
          message: 'Order event publish failed',
          eventId: event.eventId,
          eventType: event.eventType,
          orderId: event.aggregateId,
          correlationId: event.correlationId,
          errorCode: failure,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      await this.closeBrokerResources();
      return false;
    }
  }

  private async ensureChannel(): Promise<ConfirmChannel> {
    if (this.channel !== undefined) return this.channel;

    const connection = await connect(environment.rabbitMqUrl);
    connection.on('error', () => {
      this.channel = undefined;
      this.connection = undefined;
    });
    connection.on('close', () => {
      this.channel = undefined;
      this.connection = undefined;
    });
    const channel = await connection.createConfirmChannel();
    await assertOrderEventTopology(
      channel,
      environment.orderEventsExchange,
    );
    this.connection = connection;
    this.channel = channel;
    return channel;
  }

  private async publishWithConfirm(
    channel: ConfirmChannel,
    event: PendingOrderOutboxEvent,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let returned = false;
      const onReturn = (message: Message): void => {
        if (message.properties.messageId === event.eventId) returned = true;
      };
      channel.on('return', onReturn);

      channel.publish(
        environment.orderEventsExchange,
        routingKeyByEventType[event.eventType],
        Buffer.from(JSON.stringify(event.payload)),
        {
          persistent: true,
          mandatory: true,
          contentType: 'application/json',
          contentEncoding: 'utf-8',
          messageId: event.eventId,
          type: event.eventType,
          correlationId: event.correlationId,
          timestamp: event.createdAt.getTime(),
        },
        (error) => {
          setImmediate(() => {
            channel.off('return', onReturn);
            if (error !== null) reject(error);
            else if (returned) reject(new UnroutableMessageError());
            else resolve();
          });
        },
      );
    });
  }

  private async closeBrokerResources(): Promise<void> {
    const channel = this.channel;
    const connection = this.connection;
    this.channel = undefined;
    this.connection = undefined;

    await channel?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
  }
}

export function startOrderEventPublisher(): OrderEventPublisher {
  const publisher = new Publisher();
  publisher.start();
  return publisher;
}
