import express, { type Express } from 'express';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/health', (_request, response) => {
    response.status(200).json({
      service: 'inventory-service',
      status: 'UP',
    });
  });

  return app;
}