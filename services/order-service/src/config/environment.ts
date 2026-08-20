import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

const rootEnvironmentFilePath = fileURLToPath(
  new URL('../../../../.env', import.meta.url),
);

config({ path: rootEnvironmentFilePath, quiet: true });

function requireNonEmpty(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.trim() === '') {
    throw new Error(`Environment variable ${name} is required.`);
  }

  return value;
}

function readPort(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === '') return fallback;

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      `Environment variable ${name} must be an integer between 1 and 65535.`,
    );
  }

  return value;
}

function readPositiveInteger(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === '') return fallback;

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer.`);
  }

  return value;
}

function readUrl(name: string): string {
  const rawValue = requireNonEmpty(name);

  try {
    const url = new URL(rawValue);
    return url.toString().replace(/\/$/u, '');
  } catch {
    throw new Error(`Environment variable ${name} must be a valid URL.`);
  }
}

export const environment = Object.freeze({
  orderServicePort: readPort('ORDER_SERVICE_PORT', 3001),
  orderDatabaseUrl: requireNonEmpty('ORDER_DATABASE_URL'),
  inventoryServiceUrl: readUrl('INVENTORY_SERVICE_URL'),
  inventoryRequestTimeoutMs: readPositiveInteger(
    'INVENTORY_REQUEST_TIMEOUT_MS',
    2000,
  ),
  paymentServiceUrl: readUrl('PAYMENT_SERVICE_URL'),
  paymentRequestTimeoutMs: readPositiveInteger(
    'PAYMENT_REQUEST_TIMEOUT_MS',
    2000,
  ),
});
