import { environment } from '../config/environment.js';

export interface PaymentRequest {
  orderId: string;
  amountInCents: number;
  currency: 'BRL';
  paymentToken: string;
  correlationId: string;
}

interface PaymentBase {
  paymentId: string;
  orderId: string;
  amountInCents: number;
  currency: 'BRL';
  createdAt: string;
}

export interface ApprovedPayment extends PaymentBase {
  status: 'APPROVED';
}

export interface DeclinedPayment extends PaymentBase {
  status: 'DECLINED';
  declineCode: 'CARD_DECLINED' | 'PAYMENT_METHOD_REJECTED';
}

export type PaymentResult =
  | { kind: 'approved'; payment: ApprovedPayment }
  | { kind: 'declined'; payment: DeclinedPayment };

export class PaymentUnavailableError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string) {
    super('Payment operation failed.');
    this.name = 'PaymentUnavailableError';
    this.errorCode = errorCode;
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasValidPaymentBase(
  body: Record<string, unknown>,
  request: PaymentRequest,
): boolean {
  return (
    typeof body.paymentId === 'string' &&
    uuidPattern.test(body.paymentId) &&
    body.orderId === request.orderId &&
    body.amountInCents === request.amountInCents &&
    body.currency === request.currency &&
    typeof body.createdAt === 'string' &&
    !Number.isNaN(Date.parse(body.createdAt))
  );
}

function isApprovedPayment(
  value: unknown,
  request: PaymentRequest,
): value is ApprovedPayment {
  if (!isRecord(value)) return false;

  return (
    hasValidPaymentBase(value, request) &&
    value.status === 'APPROVED' &&
    !Object.hasOwn(value, 'declineCode')
  );
}

function isDeclinedPayment(
  value: unknown,
  request: PaymentRequest,
): value is DeclinedPayment {
  if (!isRecord(value)) return false;

  return (
    hasValidPaymentBase(value, request) &&
    value.status === 'DECLINED' &&
    (value.declineCode === 'CARD_DECLINED' ||
      value.declineCode === 'PAYMENT_METHOD_REJECTED')
  );
}

export async function processOrderPayment(
  request: PaymentRequest,
): Promise<PaymentResult> {
  let response: Response;

  try {
    response = await fetch(`${environment.paymentServiceUrl}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `order:${request.orderId}:payment`,
        'X-Correlation-Id': request.correlationId,
      },
      body: JSON.stringify({
        orderId: request.orderId,
        amountInCents: request.amountInCents,
        currency: request.currency,
        paymentToken: request.paymentToken,
      }),
      signal: AbortSignal.timeout(environment.paymentRequestTimeoutMs),
    });
  } catch {
    throw new PaymentUnavailableError('PAYMENT_REQUEST_FAILED');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PaymentUnavailableError('PAYMENT_RESPONSE_INVALID');
  }

  const isCreated = response.status === 201;
  const isReplay =
    response.status === 200 &&
    response.headers.get('Idempotent-Replay')?.toLowerCase() === 'true';

  if (!isCreated && !isReplay) {
    throw new PaymentUnavailableError('PAYMENT_RESPONSE_UNAVAILABLE');
  }

  if (isApprovedPayment(body, request)) {
    return { kind: 'approved', payment: body };
  }
  if (isDeclinedPayment(body, request)) {
    return { kind: 'declined', payment: body };
  }

  throw new PaymentUnavailableError('PAYMENT_RESPONSE_INVALID');
}
