export type PaymentGatewayResult =
  | { status: 'APPROVED' }
  | { status: 'DECLINED'; declineCode: string };

export function processPayment(paymentToken: string): PaymentGatewayResult {
  if (paymentToken === 'tok_approved') return { status: 'APPROVED' };

  if (paymentToken === 'tok_declined') {
    return { status: 'DECLINED', declineCode: 'CARD_DECLINED' };
  }

  return { status: 'DECLINED', declineCode: 'PAYMENT_METHOD_REJECTED' };
}
