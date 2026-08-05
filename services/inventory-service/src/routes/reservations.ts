import { Router } from 'express';

import { createInventoryReservation } from '../database/reservations.js';
import { getLoggedErrorDetails } from '../errors/logged-error.js';
import { validateReservationRequest } from '../validation/reservation.js';

export const reservationsRouter = Router();

reservationsRouter.post('/reservations', async (request, response) => {
  const rawIdempotencyKey = request.get('Idempotency-Key');

  if (rawIdempotencyKey === undefined || rawIdempotencyKey.trim() === '') {
    response.status(400).json({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'The Idempotency-Key header is required.',
    });
    return;
  }

  const validationResult = validateReservationRequest(request.body);
  if (!validationResult.valid) {
    response.status(400).json({
      code: 'INVALID_RESERVATION_REQUEST',
      message: 'The reservation request is invalid.',
      details: validationResult.error,
    });
    return;
  }

  const idempotencyKey = rawIdempotencyKey.trim();
  const correlationId = request.get('X-Correlation-Id')?.trim();
  const { orderId, sku, quantity } = validationResult.value;

  try {
    const result = await createInventoryReservation({
      idempotencyKey,
      orderId,
      sku,
      quantity,
    });

    switch (result.kind) {
      case 'created':
        response.status(201).json(result.reservation);
        return;
      case 'replayed':
        response.set('Idempotent-Replay', 'true');
        response.status(200).json(result.reservation);
        return;
      case 'idempotency-conflict':
        response.status(409).json({
          code: 'IDEMPOTENCY_KEY_CONFLICT',
          message:
            'The idempotency key was already used with a different request.',
        });
        return;
      case 'item-not-found':
        response.status(404).json({
          code: 'INVENTORY_ITEM_NOT_FOUND',
          message: 'Inventory item not found.',
          details: { sku },
        });
        return;
      case 'insufficient-stock':
        response.status(409).json({
          code: 'INVENTORY_INSUFFICIENT_STOCK',
          message: 'Insufficient inventory for the requested quantity.',
          details: {
            sku,
            requestedQuantity: quantity,
            availableQuantity: result.availableQuantity,
          },
        });
        return;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'inventory-service',
        operation: 'create-inventory-reservation',
        message: 'Inventory reservation database operation failed',
        orderId,
        sku,
        ...(correlationId === undefined ? {} : { correlationId }),
        ...getLoggedErrorDetails(error),
      }),
    );

    response.status(503).json({
      code: 'INVENTORY_DATABASE_UNAVAILABLE',
      message: 'Inventory data is temporarily unavailable.',
    });
  }
});
