import { Router } from 'express';

import {
  createInventoryReservation,
  releaseInventoryReservation,
} from '../database/reservations.js';
import { getLoggedErrorDetails } from '../errors/logged-error.js';
import {
  isEmptyReleaseRequest,
  isValidReservationId,
  validateReservationRequest,
} from '../validation/reservation.js';

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

reservationsRouter.post(
  '/reservations/:reservationId/release',
  async (request, response) => {
    const rawIdempotencyKey = request.get('Idempotency-Key');

    if (rawIdempotencyKey === undefined || rawIdempotencyKey.trim() === '') {
      response.status(400).json({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'The Idempotency-Key header is required.',
      });
      return;
    }

    const rawReservationId = request.params.reservationId;

    if (
      rawReservationId === undefined ||
      !isValidReservationId(rawReservationId)
    ) {
      response.status(400).json({
        code: 'INVALID_RESERVATION_ID',
        message: 'The reservationId path parameter must be a valid UUID.',
      });
      return;
    }

    if (!isEmptyReleaseRequest(request.body)) {
      response.status(400).json({
        code: 'INVALID_RELEASE_REQUEST',
        message: 'The reservation release request is invalid.',
        details: { field: 'body', reason: 'must be empty.' },
      });
      return;
    }

    const reservationId = rawReservationId.toLowerCase();
    const idempotencyKey = rawIdempotencyKey.trim();
    const correlationId = request.get('X-Correlation-Id')?.trim();

    try {
      const result = await releaseInventoryReservation({
        reservationId,
        idempotencyKey,
      });

      switch (result.kind) {
        case 'released':
          response.status(200).json(result.reservation);
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
        case 'reservation-not-found':
          response.status(404).json({
            code: 'INVENTORY_RESERVATION_NOT_FOUND',
            message: 'Inventory reservation was not found.',
          });
          return;
        case 'already-released':
          response.status(409).json({
            code: 'RESERVATION_ALREADY_RELEASED',
            message: 'The inventory reservation has already been released.',
          });
          return;
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'inventory-service',
          operation: 'release-inventory-reservation',
          message: 'Inventory reservation release database operation failed',
          reservationId,
          ...(correlationId === undefined ? {} : { correlationId }),
          ...getLoggedErrorDetails(error),
        }),
      );

      response.status(503).json({
        code: 'INVENTORY_DATABASE_UNAVAILABLE',
        message: 'Inventory data is temporarily unavailable.',
      });
    }
  },
);
