import { Router } from 'express';

import { createPayment } from '../database/payments.js';
import { getLoggedErrorDetails } from '../errors/logged-error.js';
import { validatePaymentRequest } from '../validation/payment.js';

export const paymentsRouter = Router();

paymentsRouter.post('/payments', async (request, response) => {
  const rawIdempotencyKey = request.get('Idempotency-Key');

  if (rawIdempotencyKey === undefined || rawIdempotencyKey.trim() === '') {
    response.status(400).json({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'The Idempotency-Key header is required.',
    });
    return;
  }

  const validationResult = validatePaymentRequest(request.body);

  if (!validationResult.valid) {
    response.status(400).json({
      code: 'INVALID_PAYMENT_REQUEST',
      message: 'The payment request is invalid.',
      details: validationResult.error,
    });
    return;
  }

  const idempotencyKey = rawIdempotencyKey.trim();
  const correlationId = request.get('X-Correlation-Id')?.trim();
  const paymentRequest = validationResult.value;

  try {
    const result = await createPayment(paymentRequest, idempotencyKey);

    switch (result.kind) {
      case 'created':
        response.status(201).json(result.payment);
        return;
      case 'replayed':
        response.set('Idempotent-Replay', 'true');
        response.status(200).json(result.payment);
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
        service: 'payment-service',
        operation: 'create-payment',
        message: 'Payment database operation failed',
        orderId: paymentRequest.orderId,
        ...(correlationId === undefined ? {} : { correlationId }),
        ...getLoggedErrorDetails(error),
      }),
    );

    response.status(503).json({
      code: 'PAYMENT_DATABASE_UNAVAILABLE',
      message: 'Payment data is temporarily unavailable.',
    });
  }
});
