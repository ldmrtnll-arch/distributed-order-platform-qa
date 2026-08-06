import { Pool } from 'pg';

import { environment } from '../config/environment.js';
import { getLoggedErrorDetails } from '../errors/logged-error.js';

export const paymentDatabasePool = new Pool({
  connectionString: environment.paymentDatabaseUrl,
  connectionTimeoutMillis: environment.paymentDatabaseConnectionTimeoutMs,
  max: 5,
});

paymentDatabasePool.on('error', (error) => {
  console.error(
    JSON.stringify({
      level: 'error',
      service: 'payment-service',
      operation: 'postgres-pool',
      message: 'Idle PostgreSQL pool connection failed',
      ...getLoggedErrorDetails(error),
    }),
  );
});

export async function checkPaymentDatabaseConnection(): Promise<void> {
  const result = await paymentDatabasePool.query<{ connected: number }>(
    'SELECT 1 AS connected',
  );

  if (result.rows[0]?.connected !== 1) {
    throw new Error(
      'Payment database health check returned an unexpected result.',
    );
  }
}
