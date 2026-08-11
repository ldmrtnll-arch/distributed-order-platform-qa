import { Router } from 'express';

import { createOrder } from '../database/orders.js';
import { getLoggedErrorDetails } from '../errors/logged-error.js';
import { validateOrderRequest } from '../validation/order.js';

export const ordersRouter = Router();

ordersRouter.post('/orders', async (request, response) => {
  const rawIdempotencyKey = request.get('Idempotency-Key');
  if (rawIdempotencyKey === undefined || rawIdempotencyKey.trim() === '') {
    response.status(400).json({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'The Idempotency-Key header is required.',
    });
    return;
  }

  const validationResult = validateOrderRequest(request.body);
  if (!validationResult.valid) {
    response.status(400).json({
      code: 'INVALID_ORDER_REQUEST',
      message: 'The order request is invalid.',
      details: validationResult.error,
    });
    return;
  }

  const idempotencyKey = rawIdempotencyKey.trim();
  const correlationId = request.get('X-Correlation-Id')?.trim();

  try {
    const result = await createOrder(validationResult.value, idempotencyKey);
    switch (result.kind) {
      case 'created':
        response.status(201).json(result.order);
        return;
      case 'replayed':
        response.set('Idempotent-Replay', 'true');
        response.status(200).json(result.order);
        return;
      case 'idempotency-conflict':
        response.status(409).json({
          code: 'IDEMPOTENCY_KEY_CONFLICT',
          message:
            'The idempotency key was already used with a different request.',
        });
        return;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'order-service',
        operation: 'create-order',
        message: 'Order database operation failed',
        ...(correlationId === undefined ? {} : { correlationId }),
        ...getLoggedErrorDetails(error),
      }),
    );
    response.status(503).json({
      code: 'ORDER_DATABASE_UNAVAILABLE',
      message: 'Order data is temporarily unavailable.',
    });
  }
});
