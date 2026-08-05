import { Router } from 'express';

import { findInventoryItemBySku } from '../database/inventory.js';
import { getLoggedErrorDetails } from '../errors/logged-error.js';

export const inventoryRouter = Router();

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
