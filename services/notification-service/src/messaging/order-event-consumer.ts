import {
  connect,
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
} from 'amqplib';
import type { ValidateFunction } from 'ajv';

import { environment } from '../config/environment.js';
import { persistNotification } from '../database/notifications.js';
import type { OrderEventV1 } from '../events/order-event.js';
import { createOrderEventValidator } from '../events/order-event-validator.js';
import { assertOrderEventTopology, notificationQueue } from './topology.js';

export interface OrderEventConsumer {
  isConnected: () => boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

class Consumer implements OrderEventConsumer {
  private connection: ChannelModel | undefined;
  private channel: Channel | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private validator: ValidateFunction<OrderEventV1> | undefined;
  private stopped = true;
  private connecting = false;

  isConnected(): boolean {
    return this.connection !== undefined && this.channel !== undefined;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.validator = await createOrderEventValidator();
    this.scheduleConnect(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    await this.closeBrokerResources();
  }

  private scheduleConnect(delayMs: number): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectAndConsume();
    }, delayMs);
  }

  private async connectAndConsume(): Promise<void> {
    if (this.stopped || this.connecting || this.isConnected()) return;
    this.connecting = true;

    try {
      const connection = await connect(environment.rabbitMqUrl);
      connection.on('error', () => this.handleConnectionLoss());
      connection.on('close', () => this.handleConnectionLoss());
      const channel = await connection.createChannel();
      await assertOrderEventTopology(
        channel,
        environment.orderEventsExchange,
      );
      await channel.prefetch(1);
      this.connection = connection;
      this.channel = channel;
      await channel.consume(
        notificationQueue,
        (message) => {
          if (message !== null) void this.processMessage(message, channel);
        },
        { noAck: false },
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'notification-service',
          operation: 'connect-order-event-consumer',
          message: 'RabbitMQ consumer connection failed',
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorCode: 'BROKER_UNAVAILABLE',
        }),
      );
      await this.closeBrokerResources();
      this.scheduleConnect(environment.reconnectIntervalMs);
    } finally {
      this.connecting = false;
    }
  }

  private async processMessage(
    message: ConsumeMessage,
    channel: Channel,
  ): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.content.toString('utf8')) as unknown;
    } catch {
      this.deadLetterInvalidMessage(channel, message);
      return;
    }

    const validator = this.validator;
    if (validator === undefined || !validator(parsed)) {
      this.deadLetterInvalidMessage(channel, message, parsed);
      return;
    }

    try {
      const result = await persistNotification(parsed);
      channel.ack(message);
      console.log(
        JSON.stringify({
          level: 'info',
          service: 'notification-service',
          operation: 'consume-order-event',
          message:
            result === 'created'
              ? 'Order event consumed'
              : 'Duplicate order event ignored',
          eventId: parsed.eventId,
          eventType: parsed.eventType,
          orderId: parsed.orderId,
          correlationId: parsed.correlationId,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'notification-service',
          operation: 'persist-order-notification',
          message: 'Notification persistence failed',
          eventId: parsed.eventId,
          eventType: parsed.eventType,
          orderId: parsed.orderId,
          correlationId: parsed.correlationId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorCode: 'NOTIFICATION_DATABASE_UNAVAILABLE',
        }),
      );
      channel.nack(message, false, true);
      await this.closeBrokerResources();
      this.scheduleConnect(environment.reconnectIntervalMs);
    }
  }

  private deadLetterInvalidMessage(
    channel: Channel,
    message: ConsumeMessage,
    parsed?: unknown,
  ): void {
    channel.nack(message, false, false);
    const record =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'notification-service',
        operation: 'consume-order-event',
        message: 'Invalid order event dead-lettered',
        eventId:
          typeof record?.eventId === 'string' ? record.eventId : undefined,
        eventType:
          typeof record?.eventType === 'string' ? record.eventType : undefined,
        orderId:
          typeof record?.orderId === 'string' ? record.orderId : undefined,
        correlationId:
          typeof record?.correlationId === 'string'
            ? record.correlationId
            : undefined,
        errorCode: 'INVALID_ORDER_EVENT',
      }),
    );
  }

  private handleConnectionLoss(): void {
    this.connection = undefined;
    this.channel = undefined;
    this.scheduleConnect(environment.reconnectIntervalMs);
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

export function createOrderEventConsumer(): OrderEventConsumer {
  return new Consumer();
}
