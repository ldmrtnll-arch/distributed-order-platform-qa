import { Router } from 'express';

import { findInventoryItemBySku } from '../database/inventory.js';

export const inventoryRouter = Router();

interface LoggedErrorDetails {
  errorMessage: string;
  errorCode?: string;
  errorName?: string;
}

function readNonEmptyStringProperty(
  value: unknown,
  property: string,
): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  try {
    const propertyValue = Reflect.get(value, property);

    return typeof propertyValue === 'string' && propertyValue.trim() !== ''
      ? propertyValue
      : undefined;
  } catch {
    return undefined;
  }
}

function redactSensitiveConnectionDetails(value: string): string {
  return value
    .replace(
      /([a-z][a-z\d+.-]*:\/\/)[^\s@]+@/giu,
      '$1[REDACTED]@',
    )
    .replace(/(password\s*[=:]\s*)[^\s,;]+/giu, '$1[REDACTED]');
}

function getFirstNestedError(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  try {
    const nestedErrors = Reflect.get(value, 'errors');

    return Array.isArray(nestedErrors) ? nestedErrors[0] : undefined;
  } catch {
    return undefined;
  }
}

function getLoggedErrorDetails(error: unknown): LoggedErrorDetails {
  const nestedError = getFirstNestedError(error);
  const rawMessage =
    readNonEmptyStringProperty(error, 'message') ??
    readNonEmptyStringProperty(nestedError, 'message');
  const errorCode =
    readNonEmptyStringProperty(error, 'code') ??
    readNonEmptyStringProperty(nestedError, 'code');
  const errorName =
    readNonEmptyStringProperty(error, 'name') ??
    readNonEmptyStringProperty(nestedError, 'name');
  const details: LoggedErrorDetails = {
    errorMessage:
      rawMessage === undefined
        ? 'Inventory database request failed with an unrecognized error.'
        : redactSensitiveConnectionDetails(rawMessage),
  };

  if (errorCode !== undefined) {
    details.errorCode = errorCode;
  }

  if (errorName !== undefined) {
    details.errorName = errorName;
  }

  return details;
}

inventoryRouter.get('/inventory/:sku', async (request, response) => {
  const normalizedSku = request.params.sku.trim().toUpperCase();

  try {
    const inventoryItem = await findInventoryItemBySku(normalizedSku);

    if (inventoryItem === null) {
      response.status(404).json({
        code: 'INVENTORY_ITEM_NOT_FOUND',
        message: 'Inventory item not found.',
        details: {
          sku: normalizedSku,
        },
      });
      return;
    }

    response.status(200).json(inventoryItem);
  } catch (error) {
    const errorDetails = getLoggedErrorDetails(error);

    console.error(
      JSON.stringify({
        level: 'error',
        service: 'inventory-service',
        operation: 'get-inventory-item',
        message: 'Inventory database query failed',
        sku: normalizedSku,
        ...errorDetails,
      }),
    );

    response.status(503).json({
      code: 'INVENTORY_DATABASE_UNAVAILABLE',
      message: 'Inventory data is temporarily unavailable.',
    });
  }
});
