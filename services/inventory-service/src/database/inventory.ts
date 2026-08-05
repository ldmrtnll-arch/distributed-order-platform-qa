import { inventoryDatabasePool } from './pool.js';

export interface InventoryItem {
  sku: string;
  name: string;
  totalQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
}

export async function findInventoryItemBySku(
  sku: string,
): Promise<InventoryItem | null> {
  const result = await inventoryDatabasePool.query<InventoryItem>(
    `SELECT
       sku,
       name,
       total_quantity AS "totalQuantity",
       reserved_quantity AS "reservedQuantity",
       total_quantity - reserved_quantity AS "availableQuantity"
     FROM products
     WHERE sku = $1`,
    [sku],
  );

  return result.rows[0] ?? null;
}
