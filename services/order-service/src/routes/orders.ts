import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import {
  InventoryUnavailableError,
  reserveInventory,
} from '../clients/inventory-client.js';
import {
  createOrder,
  markInventoryRejected,
  markInventoryReserved,
} from '../database/orders.js';
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
  const suppliedCorrelationId = request.get('X-Correlation-Id')?.trim();
  const correlationId =
    suppliedCorrelationId === undefined || suppliedCorrelationId === ''
      ? randomUUID()
      : suppliedCorrelationId;

  try {
    const result = await createOrder(validationResult.value, idempotencyKey);
    if (result.kind === 'idempotency-conflict') {
      response.status(409).json({
        code: 'IDEMPOTENCY_KEY_CONFLICT',
        message:
          'The idempotency key was already used with a different request.',
      });
      return;
    }

    if (
      result.kind === 'existing' &&
      (result.order.status === 'INVENTORY_RESERVED' ||
        result.order.status === 'INVENTORY_REJECTED')
    ) {
      response.set('Idempotent-Replay', 'true');
      response.status(200).json(result.order);
      return;
    }

    if (result.order.status !== 'PENDING') {
      throw new Error('Order is in an unsupported processing state.');
    }

    let inventoryResult;
    try {
      inventoryResult = await reserveInventory({
        orderId: result.order.orderId,
        sku: result.order.sku,
        quantity: result.order.quantity,
        correlationId,
      });
    } catch (error) {
      const inventoryError =
        error instanceof InventoryUnavailableError ? error : undefined;
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'order-service',
          operation: 'reserve-order-inventory',
          message: 'Inventory reservation operation failed',
          orderId: result.order.orderId,
          correlationId,
          errorCode: inventoryError?.errorCode ?? 'INVENTORY_REQUEST_FAILED',
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      response.status(503).json({
        code: 'ORDER_INVENTORY_UNAVAILABLE',
        message: 'Inventory service is temporarily unavailable.',
      });
      return;
    }

    if (inventoryResult.kind === 'rejected') {
      const transition = await markInventoryRejected(
        result.order.orderId,
        inventoryResult.failureCode,
      );

      if (transition.kind === 'state-conflict') {
        console.error(
          JSON.stringify({
            level: 'error',
            service: 'order-service',
            operation: 'update-order-inventory-state',
            message: 'Order inventory rejection state transition conflicted',
            orderId: result.order.orderId,
            correlationId,
            errorCode: 'ORDER_INVENTORY_STATE_CONFLICT',
          }),
        );
        response.status(503).json({
          code: 'ORDER_INVENTORY_UNAVAILABLE',
          message: 'Inventory service is temporarily unavailable.',
        });
        return;
      }

      console.log(
        JSON.stringify({
          level: 'info',
          service: 'order-service',
          operation: 'reserve-order-inventory',
          message: 'Inventory reservation was rejected',
          orderId: result.order.orderId,
          correlationId,
          failureCode: inventoryResult.failureCode,
        }),
      );

      if (result.kind === 'existing') {
        response.set('Idempotent-Replay', 'true');
        response.status(200).json(transition.order);
        return;
      }

      response.status(201).json(transition.order);
      return;
    }

    const transition = await markInventoryReserved(
      result.order.orderId,
      inventoryResult.reservation.reservationId,
    );

    if (transition.kind === 'state-conflict') {
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'order-service',
          operation: 'update-order-inventory-state',
          message: 'Order inventory state transition conflicted',
          orderId: result.order.orderId,
          correlationId,
          errorCode: 'ORDER_INVENTORY_STATE_CONFLICT',
        }),
      );
      response.status(503).json({
        code: 'ORDER_INVENTORY_UNAVAILABLE',
        message: 'Inventory service is temporarily unavailable.',
      });
      return;
    }

    if (result.kind === 'existing') {
      response.set('Idempotent-Replay', 'true');
      response.status(200).json(transition.order);
      return;
    }

    response.status(201).json(transition.order);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        service: 'order-service',
        operation: 'create-order',
        message: 'Order database operation failed',
        correlationId,
        ...getLoggedErrorDetails(error),
      }),
    );
    response.status(503).json({
      code: 'ORDER_DATABASE_UNAVAILABLE',
      message: 'Order data is temporarily unavailable.',
    });
  }
});
