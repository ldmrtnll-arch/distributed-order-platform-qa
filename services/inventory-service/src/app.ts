import express, { type Express } from 'express';

import { checkInventoryDatabaseConnection } from './database/pool.js';
import { inventoryRouter } from './routes/inventory.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json());
  app.use(inventoryRouter);

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

  return app;
}
