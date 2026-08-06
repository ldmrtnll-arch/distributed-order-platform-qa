import express, { type Express } from 'express';

import { checkOrderDatabaseConnection } from './database/pool.js';
import { getLoggedErrorDetails } from './errors/logged-error.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  app.get('/health', async (_request, response) => {
    try {
      await checkOrderDatabaseConnection();
      response.status(200).json({
        service: 'order-service',
        status: 'UP',
        dependencies: { database: 'UP' },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'order-service',
          operation: 'database-health-check',
          message: 'Order database health check failed',
          ...getLoggedErrorDetails(error),
        }),
      );
      response.status(503).json({
        service: 'order-service',
        status: 'DEGRADED',
        dependencies: { database: 'DOWN' },
      });
    }
  });

  return app;
}
