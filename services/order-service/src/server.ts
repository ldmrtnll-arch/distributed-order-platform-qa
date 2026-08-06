import type { Server } from 'node:http';

import { createApp } from './app.js';
import { environment } from './config/environment.js';
import { closeOrderDatabasePool } from './database/pool.js';

const app = createApp();
let server: Server;
let shuttingDown = false;

async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(
    JSON.stringify({
      level: 'info',
      service: 'order-service',
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
    await closeOrderDatabasePool();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'order-service',
        operation: 'shutdown-server',
        message: 'Order Service shutdown failed',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    process.exitCode = 1;
  }
}

server = app.listen(environment.orderServicePort, '0.0.0.0', () => {
  console.log(
    JSON.stringify({
      level: 'info',
      service: 'order-service',
      operation: 'start-server',
      port: environment.orderServicePort,
    }),
  );
});

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
