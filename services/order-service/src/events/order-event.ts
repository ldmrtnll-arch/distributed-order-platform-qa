export type TerminalOrderStatus =
  | 'CONFIRMED'
  | 'INVENTORY_REJECTED'
  | 'PAYMENT_DECLINED'
  | 'COMPENSATION_FAILED';

export type OrderEventType =
  | 'ORDER_CONFIRMED'
  | 'ORDER_INVENTORY_REJECTED'
  | 'ORDER_PAYMENT_DECLINED'
  | 'ORDER_COMPENSATION_FAILED';

export interface OrderEventV1 {
  eventId: string;
  eventType: OrderEventType;
  eventVersion: 1;
  occurredAt: string;
  correlationId: string;
  orderId: string;
  data: {
    status: TerminalOrderStatus;
    sku: string;
    quantity: number;
    amountInCents: number;
    currency: 'BRL';
    failureCode: string | null;
  };
}

export const routingKeyByEventType: Readonly<Record<OrderEventType, string>> = {
  ORDER_CONFIRMED: 'order.confirmed',
  ORDER_INVENTORY_REJECTED: 'order.inventory_rejected',
  ORDER_PAYMENT_DECLINED: 'order.payment_declined',
  ORDER_COMPENSATION_FAILED: 'order.compensation_failed',
};

export const eventTypeByStatus: Readonly<
  Record<TerminalOrderStatus, OrderEventType>
> = {
  CONFIRMED: 'ORDER_CONFIRMED',
  INVENTORY_REJECTED: 'ORDER_INVENTORY_REJECTED',
  PAYMENT_DECLINED: 'ORDER_PAYMENT_DECLINED',
  COMPENSATION_FAILED: 'ORDER_COMPENSATION_FAILED',
};
