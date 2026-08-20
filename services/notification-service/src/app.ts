import express, { type Express } from 'express';

import { checkNotificationDatabaseConnection } from './database/pool.js';
import type { OrderEventConsumer } from './messaging/order-event-consumer.js';

export function createApp(consumer: OrderEventConsumer): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', async (_request, response) => {
    let databaseUp = false;
    try {
      await checkNotificationDatabaseConnection();
      databaseUp = true;
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'notification-service',
          operation: 'database-health-check',
          message: 'Notification database health check failed',
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
    }

    const rabbitMqUp = consumer.isConnected();
    response.status(databaseUp && rabbitMqUp ? 200 : 503).json({
      service: 'notification-service',
      status: databaseUp && rabbitMqUp ? 'UP' : 'DEGRADED',
      dependencies: {
        database: databaseUp ? 'UP' : 'DOWN',
        rabbitmq: rabbitMqUp ? 'UP' : 'DOWN',
      },
    });
  });

  return app;
}
