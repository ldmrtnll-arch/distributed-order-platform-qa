import { Pool } from 'pg';

import { environment } from '../config/environment.js';

export const inventoryDatabasePool = new Pool({
  connectionString: environment.inventoryDatabaseUrl,
  connectionTimeoutMillis:
    environment.inventoryDatabaseConnectionTimeoutMs,
  max: 5,
});

export async function checkInventoryDatabaseConnection(): Promise<void> {
  const result = await inventoryDatabasePool.query<{
    connected: number;
  }>('SELECT 1 AS connected');

  const firstRow = result.rows[0];

  if (firstRow?.connected !== 1) {
    throw new Error(
      'Inventory database health check returned an unexpected result.',
    );
  }
}