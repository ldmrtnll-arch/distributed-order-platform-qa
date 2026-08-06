import { config } from 'dotenv';

config();

function requireNonEmpty(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function readPositiveInteger(name: string, fallback: number): number {
  const rawValue = process.env[name];

  if (rawValue === undefined || rawValue.trim() === '') return fallback;

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

export const environment = {
  paymentDatabaseUrl: requireNonEmpty('PAYMENT_DATABASE_URL'),
  paymentDatabaseConnectionTimeoutMs: readPositiveInteger(
    'PAYMENT_DATABASE_CONNECTION_TIMEOUT_MS',
    3000,
  ),
};
