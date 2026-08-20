import { Client } from 'pg';

export async function ensureNotificationDatabase(
  notificationConnectionString: string,
): Promise<void> {
  const notificationUrl = new URL(notificationConnectionString);
  if (notificationUrl.pathname !== '/notifications_db') {
    throw new Error(
      'NOTIFICATION_DATABASE_URL must target the notifications_db database.',
    );
  }

  const adminUrl = new URL(notificationUrl);
  adminUrl.pathname = '/platform_admin';
  const client = new Client({ connectionString: adminUrl.toString() });
  try {
    await client.connect();
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_database WHERE datname = 'notifications_db'
       ) AS exists`,
    );
    if (result.rows[0]?.exists !== true) {
      await client.query('CREATE DATABASE notifications_db');
    }
  } finally {
    await client.end();
  }
}
