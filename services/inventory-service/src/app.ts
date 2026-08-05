import express, { type Express } from 'express';

import type { ErrorRequestHandler } from 'express';

import { checkInventoryDatabaseConnection } from './database/pool.js';
import { inventoryRouter } from './routes/inventory.js';
import { reservationsRouter } from './routes/reservations.js';

const malformedJsonErrorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  next,
) => {
  if (
    error instanceof SyntaxError &&
    Reflect.get(error, 'status') === 400
  ) {
    response.status(400).json({
      code: 'INVALID_RESERVATION_REQUEST',
      message: 'The reservation request is invalid.',
      details: {
        field: 'body',
        reason: 'must contain valid JSON.',
      },
    });
    return;
  }

  next(error);
};

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json());
  app.use(inventoryRouter);
  app.use(reservationsRouter);

  app.get('/health', async (_request, response) => {
    try {
      await checkInventoryDatabaseConnection();

      response.status(200).json({
        service: 'inventory-service',
        status: 'UP',
        dependencies: {
          database: 'UP',
        },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'inventory-service',
          operation: 'database-health-check',
          message: 'Inventory database health check failed',
          error:
            error instanceof Error
              ? error.message
              : 'Unknown database error',
        }),
      );

      response.status(503).json({
        service: 'inventory-service',
        status: 'DEGRADED',
        dependencies: {
          database: 'DOWN',
        },
      });
    }
  });

  app.use(malformedJsonErrorHandler);

  return app;
}
