import { randomUUID } from 'node:crypto';

import { Router, type Response } from 'express';

import {
  InventoryUnavailableError,
  releaseInventory,
  reserveInventory,
} from '../clients/inventory-client.js';
import {
  PaymentUnavailableError,
  processOrderPayment,
} from '../clients/payment-client.js';
import {
  createOrder,
  markCompensationFailed,
  markInventoryRejected,
  markInventoryReserved,
  markPaymentConfirmed,
  markPaymentDeclined,
  type CreateOrderResult,
  type Order,
  type OrderState,
  type OrderTransitionResult,
} from '../database/orders.js';
import { getLoggedErrorDetails } from '../errors/logged-error.js';
import { validateOrderRequest } from '../validation/order.js';

export const ordersRouter = Router();

const terminalStatuses = new Set<Order['status']>([
  'CONFIRMED',
  'INVENTORY_REJECTED',
  'PAYMENT_DECLINED',
  'COMPENSATION_FAILED',
]);

function isTerminal(state: OrderState): boolean {
  return terminalStatuses.has(state.order.status);
}

function sendOrder(
  response: Response,
  state: OrderState,
  creationKind: Exclude<CreateOrderResult['kind'], 'idempotency-conflict'>,
): void {
  if (creationKind === 'existing') {
    response.set('Idempotent-Replay', 'true');
    response.status(200).json(state.order);
    return;
  }

  response.status(201).json(state.order);
}

function transitionState(
  transition: OrderTransitionResult,
): OrderState | null {
  return transition.kind === 'state-conflict' ? null : transition.state;
}

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

    const creationKind = result.kind;
    let state = result.state;

    if (isTerminal(state)) {
      sendOrder(response, state, creationKind);
      return;
    }

    if (state.order.status === 'PENDING') {
      let inventoryResult;
      try {
        inventoryResult = await reserveInventory({
          orderId: state.order.orderId,
          sku: state.order.sku,
          quantity: state.order.quantity,
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
            orderId: state.order.orderId,
            correlationId,
            errorCode:
              inventoryError?.errorCode ?? 'INVENTORY_REQUEST_FAILED',
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
        const rejectedState = transitionState(
          await markInventoryRejected(
            state.order.orderId,
            inventoryResult.failureCode,
          ),
        );
        if (rejectedState === null) {
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
            orderId: state.order.orderId,
            correlationId,
            failureCode: inventoryResult.failureCode,
          }),
        );
        sendOrder(response, rejectedState, creationKind);
        return;
      }

      const reservedState = transitionState(
        await markInventoryReserved(
          state.order.orderId,
          inventoryResult.reservation.reservationId,
        ),
      );
      if (reservedState === null) {
        response.status(503).json({
          code: 'ORDER_INVENTORY_UNAVAILABLE',
          message: 'Inventory service is temporarily unavailable.',
        });
        return;
      }
      state = reservedState;

      if (isTerminal(state)) {
        sendOrder(response, state, creationKind);
        return;
      }
    }

    if (
      state.order.status !== 'INVENTORY_RESERVED' ||
      state.inventoryReservationId === null
    ) {
      throw new Error('Order is in an unsupported processing state.');
    }

    let paymentResult;
    try {
      paymentResult = await processOrderPayment({
        orderId: state.order.orderId,
        amountInCents: state.order.amountInCents,
        currency: state.order.currency,
        paymentToken: validationResult.value.paymentToken,
        correlationId,
      });
    } catch (error) {
      const paymentError =
        error instanceof PaymentUnavailableError ? error : undefined;
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'order-service',
          operation: 'process-order-payment',
          message: 'Payment operation failed',
          orderId: state.order.orderId,
          correlationId,
          errorCode: paymentError?.errorCode ?? 'PAYMENT_REQUEST_FAILED',
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      response.status(503).json({
        code: 'ORDER_PAYMENT_UNAVAILABLE',
        message: 'Payment service is temporarily unavailable.',
      });
      return;
    }

    if (paymentResult.kind === 'approved') {
      const confirmedState = transitionState(
        await markPaymentConfirmed(
          state.order.orderId,
          paymentResult.payment.paymentId,
        ),
      );
      if (confirmedState === null) {
        response.status(503).json({
          code: 'ORDER_PAYMENT_UNAVAILABLE',
          message: 'Payment service is temporarily unavailable.',
        });
        return;
      }
      sendOrder(response, confirmedState, creationKind);
      return;
    }

    try {
      await releaseInventory({
        reservationId: state.inventoryReservationId,
        orderId: state.order.orderId,
        sku: state.order.sku,
        quantity: state.order.quantity,
        correlationId,
      });
    } catch (error) {
      const compensationState = transitionState(
        await markCompensationFailed(
          state.order.orderId,
          paymentResult.payment.paymentId,
        ),
      );
      if (compensationState === null) {
        throw new Error('Order compensation state transition conflicted.');
      }

      const inventoryError =
        error instanceof InventoryUnavailableError ? error : undefined;
      console.error(
        JSON.stringify({
          level: 'error',
          service: 'order-service',
          operation: 'compensate-order-inventory',
          message: 'Inventory compensation operation failed',
          orderId: state.order.orderId,
          correlationId,
          errorCode:
            inventoryError?.errorCode ?? 'INVENTORY_RELEASE_REQUEST_FAILED',
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      response.status(503).json({
        code: 'ORDER_COMPENSATION_FAILED',
        message:
          'The payment was declined and the inventory reservation could not be released.',
      });
      return;
    }

    const declinedState = transitionState(
      await markPaymentDeclined(
        state.order.orderId,
        paymentResult.payment.paymentId,
        paymentResult.payment.declineCode,
      ),
    );
    if (declinedState === null) {
      throw new Error('Order payment decline state transition conflicted.');
    }
    sendOrder(response, declinedState, creationKind);
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
