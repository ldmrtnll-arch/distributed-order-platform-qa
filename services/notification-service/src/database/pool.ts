import { Pool } from 'pg';

import { environment } from '../config/environment.js';

export const notificationDatabasePool = new Pool({
  connectionString: environment.notificationDatabaseUrl,
  connectionTimeoutMillis: environment.notificationDatabaseConnectionTimeoutMs,
  max: 5,
});

notificationDatabasePool.on('error', (error) => {
  console.error(
    JSON.stringify({
      level: 'error',
      service: 'notification-service',
      operation: 'postgres-pool',
      message: 'Idle PostgreSQL pool connection failed',
      errorMessage: error.message || 'Unknown database error',
      errorCode:
        typeof Reflect.get(error, 'code') === 'string'
          ? Reflect.get(error, 'code')
          : undefined,
      errorName: error.name,
    }),
  );
});

export async function checkNotificationDatabaseConnection(): Promise<void> {
  const result = await notificationDatabasePool.query<{ connected: number }>(
    'SELECT 1 AS connected',
  );
  if (result.rows[0]?.connected !== 1) {
    throw new Error(
      'Notification database health check returned an unexpected result.',
    );
  }
}

export async function closeNotificationDatabasePool(): Promise<void> {
  await notificationDatabasePool.end();
}
