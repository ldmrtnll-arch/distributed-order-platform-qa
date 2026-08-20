import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

config({
  path: fileURLToPath(new URL('../../../../.env', import.meta.url)),
  quiet: true,
});

function readNonEmpty(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value.trim() === '') {
    throw new Error(`Environment variable ${name} is required.`);
  }
  return value.trim();
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer.`);
  }
  return value;
}

function readPort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      `Environment variable ${name} must be an integer between 1 and 65535.`,
    );
  }
  return value;
}

function readUrl(name: string, fallback: string): string {
  const value = readNonEmpty(name, fallback);
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`Environment variable ${name} must be a valid URL.`);
  }
}

export const environment = Object.freeze({
  notificationServicePort: readPort('NOTIFICATION_SERVICE_PORT', 3004),
  notificationDatabaseUrl: readNonEmpty(
    'NOTIFICATION_DATABASE_URL',
    'postgresql://qa_user:qa_password@localhost:5433/notifications_db',
  ),
  notificationDatabaseConnectionTimeoutMs: readPositiveInteger(
    'NOTIFICATION_DATABASE_CONNECTION_TIMEOUT_MS',
    3000,
  ),
  rabbitMqUrl: readUrl(
    'RABBITMQ_URL',
    'amqp://qa_user:qa_password@127.0.0.1:5672/qa',
  ),
  orderEventsExchange: readNonEmpty('ORDER_EVENTS_EXCHANGE', 'order.events'),
  reconnectIntervalMs: readPositiveInteger(
    'NOTIFICATION_RECONNECT_INTERVAL_MS',
    500,
  ),
});
