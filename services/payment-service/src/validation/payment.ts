export interface PaymentRequest {
  orderId: string;
  amountInCents: number;
  currency: 'BRL';
  paymentToken: string;
}

export interface PaymentValidationError {
  field: string;
  reason: string;
}

export type PaymentValidationResult =
  | { valid: true; value: PaymentRequest }
  | { valid: false; error: PaymentValidationError };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const allowedFields = new Set([
  'orderId',
  'amountInCents',
  'currency',
  'paymentToken',
]);

function invalid(field: string, reason: string): PaymentValidationResult {
  return { valid: false, error: { field, reason } };
}

export function validatePaymentRequest(body: unknown): PaymentValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return invalid('body', 'must be a JSON object.');
  }

  const requestBody = body as Record<string, unknown>;

  if (!Object.hasOwn(requestBody, 'orderId')) {
    return invalid('orderId', 'is required.');
  }
  if (
    typeof requestBody.orderId !== 'string' ||
    !uuidPattern.test(requestBody.orderId)
  ) {
    return invalid('orderId', 'must be a valid UUID.');
  }
  if (!Object.hasOwn(requestBody, 'amountInCents')) {
    return invalid('amountInCents', 'is required.');
  }
  if (
    typeof requestBody.amountInCents !== 'number' ||
    !Number.isFinite(requestBody.amountInCents)
  ) {
    return invalid('amountInCents', 'must be a finite number.');
  }
  if (!Number.isInteger(requestBody.amountInCents)) {
    return invalid('amountInCents', 'must be an integer.');
  }
  if (requestBody.amountInCents <= 0) {
    return invalid('amountInCents', 'must be greater than zero.');
  }
  if (!Object.hasOwn(requestBody, 'currency')) {
    return invalid('currency', 'is required.');
  }
  if (typeof requestBody.currency !== 'string') {
    return invalid('currency', 'must be a string.');
  }

  const currency = requestBody.currency.trim().toUpperCase();

  if (currency !== 'BRL') {
    return invalid('currency', 'must be BRL.');
  }
  if (!Object.hasOwn(requestBody, 'paymentToken')) {
    return invalid('paymentToken', 'is required.');
  }
  if (typeof requestBody.paymentToken !== 'string') {
    return invalid('paymentToken', 'must be a string.');
  }

  const paymentToken = requestBody.paymentToken.trim();

  if (paymentToken === '') {
    return invalid('paymentToken', 'must be a non-empty string.');
  }

  const unexpectedField = Object.keys(requestBody).find(
    (field) => !allowedFields.has(field),
  );

  if (unexpectedField !== undefined) {
    return invalid(unexpectedField, 'is not allowed.');
  }

  return {
    valid: true,
    value: {
      orderId: requestBody.orderId,
      amountInCents: requestBody.amountInCents,
      currency,
      paymentToken,
    },
  };
}
