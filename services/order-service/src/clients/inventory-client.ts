import { environment } from '../config/environment.js';

export interface InventoryReservationRequest {
  orderId: string;
  sku: string;
  quantity: number;
  correlationId: string;
}

export interface InventoryReservation {
  reservationId: string;
  orderId: string;
  sku: string;
  quantity: number;
  status: 'RESERVED';
  createdAt: string;
}

export type InventoryRejectionCode =
  | 'INVENTORY_ITEM_NOT_FOUND'
  | 'INVENTORY_INSUFFICIENT_STOCK';

export type InventoryReservationResult =
  | { kind: 'reserved'; reservation: InventoryReservation }
  | { kind: 'rejected'; failureCode: InventoryRejectionCode };

export interface InventoryReleaseRequest {
  reservationId: string;
  orderId: string;
  sku: string;
  quantity: number;
  correlationId: string;
}

export interface ReleasedInventoryReservation {
  reservationId: string;
  orderId: string;
  sku: string;
  quantity: number;
  status: 'RELEASED';
  releasedAt: string;
}

export class InventoryUnavailableError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string) {
    super('Inventory reservation operation failed.');
    this.name = 'InventoryUnavailableError';
    this.errorCode = errorCode;
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function isValidReservation(
  value: unknown,
  request: InventoryReservationRequest,
): value is InventoryReservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const body = value as Record<string, unknown>;
  return (
    typeof body.reservationId === 'string' &&
    uuidPattern.test(body.reservationId) &&
    body.orderId === request.orderId &&
    body.sku === request.sku &&
    body.quantity === request.quantity &&
    body.status === 'RESERVED' &&
    typeof body.createdAt === 'string' &&
    !Number.isNaN(Date.parse(body.createdAt))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isItemNotFound(
  value: unknown,
  request: InventoryReservationRequest,
): boolean {
  if (!isRecord(value) || !isRecord(value.details)) return false;

  return (
    value.code === 'INVENTORY_ITEM_NOT_FOUND' &&
    value.message === 'Inventory item not found.' &&
    value.details.sku === request.sku
  );
}

function isInsufficientStock(
  value: unknown,
  request: InventoryReservationRequest,
): boolean {
  if (!isRecord(value) || !isRecord(value.details)) return false;

  const availableQuantity = value.details.availableQuantity;
  return (
    value.code === 'INVENTORY_INSUFFICIENT_STOCK' &&
    value.message === 'Insufficient inventory for the requested quantity.' &&
    value.details.sku === request.sku &&
    value.details.requestedQuantity === request.quantity &&
    typeof availableQuantity === 'number' &&
    Number.isFinite(availableQuantity) &&
    Number.isInteger(availableQuantity) &&
    availableQuantity >= 0
  );
}

function isValidRelease(
  value: unknown,
  request: InventoryReleaseRequest,
): value is ReleasedInventoryReservation {
  if (!isRecord(value)) return false;

  return (
    value.reservationId === request.reservationId &&
    value.orderId === request.orderId &&
    value.sku === request.sku &&
    value.quantity === request.quantity &&
    value.status === 'RELEASED' &&
    typeof value.releasedAt === 'string' &&
    !Number.isNaN(Date.parse(value.releasedAt))
  );
}

export async function reserveInventory(
  request: InventoryReservationRequest,
): Promise<InventoryReservationResult> {
  let response: Response;

  try {
    response = await fetch(`${environment.inventoryServiceUrl}/reservations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': `order:${request.orderId}:inventory-reservation`,
        'X-Correlation-Id': request.correlationId,
      },
      body: JSON.stringify({
        orderId: request.orderId,
        sku: request.sku,
        quantity: request.quantity,
      }),
      signal: AbortSignal.timeout(environment.inventoryRequestTimeoutMs),
    });
  } catch {
    throw new InventoryUnavailableError('INVENTORY_REQUEST_FAILED');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new InventoryUnavailableError('INVENTORY_RESPONSE_INVALID');
  }

  const isCreated = response.status === 201;
  const isReplay =
    response.status === 200 &&
    response.headers.get('Idempotent-Replay')?.toLowerCase() === 'true';

  if (isCreated || isReplay) {
    if (!isValidReservation(body, request)) {
      throw new InventoryUnavailableError('INVENTORY_RESPONSE_INVALID');
    }

    return { kind: 'reserved', reservation: body };
  }

  if (response.status === 404 && isItemNotFound(body, request)) {
    return { kind: 'rejected', failureCode: 'INVENTORY_ITEM_NOT_FOUND' };
  }

  if (response.status === 409 && isInsufficientStock(body, request)) {
    return {
      kind: 'rejected',
      failureCode: 'INVENTORY_INSUFFICIENT_STOCK',
    };
  }

  throw new InventoryUnavailableError('INVENTORY_RESPONSE_UNAVAILABLE');
}

export async function releaseInventory(
  request: InventoryReleaseRequest,
): Promise<ReleasedInventoryReservation> {
  let response: Response;

  try {
    response = await fetch(
      `${environment.inventoryServiceUrl}/reservations/${request.reservationId}/release`,
      {
        method: 'POST',
        headers: {
          'Idempotency-Key': `order:${request.orderId}:inventory-release`,
          'X-Correlation-Id': request.correlationId,
        },
        signal: AbortSignal.timeout(environment.inventoryRequestTimeoutMs),
      },
    );
  } catch {
    throw new InventoryUnavailableError('INVENTORY_RELEASE_REQUEST_FAILED');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new InventoryUnavailableError('INVENTORY_RELEASE_RESPONSE_INVALID');
  }

  const isReleased = response.status === 200;
  if (!isReleased || !isValidRelease(body, request)) {
    throw new InventoryUnavailableError('INVENTORY_RELEASE_UNAVAILABLE');
  }

  return body;
}
