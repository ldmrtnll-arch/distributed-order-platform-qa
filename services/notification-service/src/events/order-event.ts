export type OrderEventType =
  | 'ORDER_CONFIRMED'
  | 'ORDER_INVENTORY_REJECTED'
  | 'ORDER_PAYMENT_DECLINED'
  | 'ORDER_COMPENSATION_FAILED';

export type TerminalOrderStatus =
  | 'CONFIRMED'
  | 'INVENTORY_REJECTED'
  | 'PAYMENT_DECLINED'
  | 'COMPENSATION_FAILED';

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
