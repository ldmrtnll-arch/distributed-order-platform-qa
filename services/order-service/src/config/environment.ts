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

export const environment = Object.freeze({
  orderServicePort: readPort('ORDER_SERVICE_PORT', 3001),
  orderDatabaseUrl: requireNonEmpty('ORDER_DATABASE_URL'),
});
