import express, { type ErrorRequestHandler, type Express } from 'express';

import { checkOrderDatabaseConnection } from './database/pool.js';
import { getLoggedErrorDetails } from './errors/logged-error.js';
import { ordersRouter } from './routes/orders.js';

const malformedJsonErrorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  next,
) => {
  if (error instanceof SyntaxError && Reflect.get(error, 'status') === 400) {
    response.status(400).json({
      code: 'INVALID_ORDER_REQUEST',
      message: 'The order request is invalid.',
      details: { field: 'body', reason: 'must contain valid JSON.' },
    });
    return;
  }
  next(error);
};

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(
    '/orders',
    express.raw({
      type: (request) =>
        request.headers['content-type']
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase() !== 'application/json',
    }),
  );
  app.use(express.json());
  app.use(ordersRouter);

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

  app.use(malformedJsonErrorHandler);

  return app;
}
