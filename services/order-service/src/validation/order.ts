export interface OrderRequest {
  sku: string;
  quantity: number;
  amountInCents: number;
  currency: 'BRL';
  paymentToken: string;
}

export interface OrderValidationError {
  field: string;
  reason: string;
}

export type OrderValidationResult =
  | { valid: true; value: OrderRequest }
  | { valid: false; error: OrderValidationError };

const allowedFields = new Set([
  'sku',
  'quantity',
  'amountInCents',
  'currency',
  'paymentToken',
]);

function invalid(field: string, reason: string): OrderValidationResult {
  return { valid: false, error: { field, reason } };
}

function validatePositiveInteger(
  body: Record<string, unknown>,
  field: 'quantity' | 'amountInCents',
): OrderValidationError | undefined {
  if (!Object.hasOwn(body, field)) return { field, reason: 'is required.' };
  const value = body[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { field, reason: 'must be a finite number.' };
  }
  if (!Number.isInteger(value)) return { field, reason: 'must be an integer.' };
  if (value <= 0) return { field, reason: 'must be greater than zero.' };
  return undefined;
}

export function validateOrderRequest(body: unknown): OrderValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return invalid('body', 'must be a JSON object.');
  }

  const requestBody = body as Record<string, unknown>;
  if (!Object.hasOwn(requestBody, 'sku')) return invalid('sku', 'is required.');
  if (typeof requestBody.sku !== 'string') {
    return invalid('sku', 'must be a string.');
  }
  const sku = requestBody.sku.trim().toUpperCase();
  if (sku === '') return invalid('sku', 'must be a non-empty string.');

  const quantityError = validatePositiveInteger(requestBody, 'quantity');
  if (quantityError !== undefined) return { valid: false, error: quantityError };
  const amountError = validatePositiveInteger(requestBody, 'amountInCents');
  if (amountError !== undefined) return { valid: false, error: amountError };

  if (!Object.hasOwn(requestBody, 'currency')) {
    return invalid('currency', 'is required.');
  }
  if (typeof requestBody.currency !== 'string') {
    return invalid('currency', 'must be a string.');
  }
  const currency = requestBody.currency.trim().toUpperCase();
  if (currency === '') return invalid('currency', 'must be a non-empty string.');
  if (currency !== 'BRL') return invalid('currency', 'must be BRL.');

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
      sku,
      quantity: requestBody.quantity as number,
      amountInCents: requestBody.amountInCents as number,
      currency,
      paymentToken,
    },
  };
}
