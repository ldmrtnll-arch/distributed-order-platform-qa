export interface ReservationRequest {
  orderId: string;
  sku: string;
  quantity: number;
}

export interface ReservationValidationError {
  field: string;
  reason: string;
}

export type ReservationValidationResult =
  | { valid: true; value: ReservationRequest }
  | { valid: false; error: ReservationValidationError };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const allowedFields = new Set(['orderId', 'sku', 'quantity']);

export function isValidReservationId(value: string): boolean {
  return uuidPattern.test(value);
}

export function isEmptyReleaseRequest(body: unknown): boolean {
  return body === undefined;
}

function invalid(field: string, reason: string): ReservationValidationResult {
  return { valid: false, error: { field, reason } };
}

export function validateReservationRequest(body: unknown): ReservationValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return invalid('body', 'must be a JSON object.');
  }

  const requestBody = body as Record<string, unknown>;

  if (!Object.hasOwn(requestBody, 'orderId')) {
    return invalid('orderId', 'is required.');
  }
  if (typeof requestBody.orderId !== 'string' || !uuidPattern.test(requestBody.orderId)) {
    return invalid('orderId', 'must be a valid UUID.');
  }
  if (!Object.hasOwn(requestBody, 'sku')) {
    return invalid('sku', 'is required.');
  }
  if (typeof requestBody.sku !== 'string') {
    return invalid('sku', 'must be a string.');
  }

  const normalizedSku = requestBody.sku.trim().toUpperCase();
  if (normalizedSku === '') {
    return invalid('sku', 'must be a non-empty string.');
  }
  if (!Object.hasOwn(requestBody, 'quantity')) {
    return invalid('quantity', 'is required.');
  }
  if (typeof requestBody.quantity !== 'number' || !Number.isFinite(requestBody.quantity)) {
    return invalid('quantity', 'must be a finite number.');
  }
  if (!Number.isInteger(requestBody.quantity)) {
    return invalid('quantity', 'must be an integer.');
  }
  if (requestBody.quantity <= 0) {
    return invalid('quantity', 'must be greater than zero.');
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
      sku: normalizedSku,
      quantity: requestBody.quantity,
    },
  };
}
