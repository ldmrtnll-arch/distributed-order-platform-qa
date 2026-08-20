import type { Server } from 'node:http';

import { createApp } from './app.js';
import { environment } from './config/environment.js';
import { closeNotificationDatabasePool } from './database/pool.js';
import { createOrderEventConsumer } from './messaging/order-event-consumer.js';

const consumer = createOrderEventConsumer();
await consumer.start();
const app = createApp(consumer);
let shuttingDown = false;
let server: Server;

async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(
    JSON.stringify({
      level: 'info',
      service: 'notification-service',
      operation: 'shutdown-server',
      signal,
    }),
  );

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
    await consumer.stop();
    await closeNotificationDatabasePool();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'notification-service',
        operation: 'shutdown-server',
        message: 'Notification Service shutdown failed',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    process.exitCode = 1;
  }
}

server = app.listen(environment.notificationServicePort, '0.0.0.0', () => {
  console.log(
    JSON.stringify({
      level: 'info',
      service: 'notification-service',
      operation: 'start-server',
      port: environment.notificationServicePort,
    }),
  );
});

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
