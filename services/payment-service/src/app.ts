import express, { type ErrorRequestHandler, type Express } from 'express';

import { checkPaymentDatabaseConnection } from './database/pool.js';
import { getLoggedErrorDetails } from './errors/logged-error.js';
import { paymentsRouter } from './routes/payments.js';

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
      code: 'INVALID_PAYMENT_REQUEST',
      message: 'The payment request is invalid.',
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
  app.use(paymentsRouter);

  app.get('/health', async (_request, response) => {
    try {
      await checkPaymentDatabaseConnection();
      response.status(200).json({
        service: 'payment-service',
        status: 'UP',
        dependencies: { database: 'UP' },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'payment-service',
          operation: 'database-health-check',
          message: 'Payment database health check failed',
          ...getLoggedErrorDetails(error),
        }),
      );
      response.status(503).json({
        service: 'payment-service',
        status: 'DEGRADED',
        dependencies: { database: 'DOWN' },
      });
    }
  });

  app.use(malformedJsonErrorHandler);

  return app;
}
