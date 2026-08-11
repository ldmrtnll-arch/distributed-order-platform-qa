import { Pool } from 'pg';

import { environment } from '../config/environment.js';
import { getLoggedErrorDetails } from '../errors/logged-error.js';

export const orderDatabasePool = new Pool({
  connectionString: environment.orderDatabaseUrl,
  connectionTimeoutMillis: 3000,
  max: 5,
});

orderDatabasePool.on('error', (error) => {
  console.error(
    JSON.stringify({
      level: 'error',
      service: 'order-service',
      operation: 'postgres-pool',
      message: 'Idle PostgreSQL pool connection failed',
      ...getLoggedErrorDetails(error),
    }),
  );
});

export async function checkOrderDatabaseConnection(): Promise<void> {
  const result = await orderDatabasePool.query<{ connected: number }>(
    'SELECT 1 AS connected',
  );

  if (result.rows[0]?.connected !== 1) {
    throw new Error('Order database health check returned an unexpected result.');
  }
}

export async function closeOrderDatabasePool(): Promise<void> {
  await orderDatabasePool.end();
}
