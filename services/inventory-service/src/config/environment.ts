import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

const rootEnvironmentFilePath = fileURLToPath(
  new URL('../../../../.env', import.meta.url),
);

config({
  path: rootEnvironmentFilePath,
});

function getRequiredEnvironmentVariable(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.trim() === '') {
    throw new Error(`Environment variable ${name} is required.`);
  }

  return value;
}

function getPositiveIntegerEnvironmentVariable(name: string): number {
  const rawValue = getRequiredEnvironmentVariable(name);
  const parsedValue = Number(rawValue);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(
      `Environment variable ${name} must be a positive integer.`,
    );
  }

  return parsedValue;
}

export const environment = Object.freeze({
  inventoryDatabaseUrl: getRequiredEnvironmentVariable(
    'INVENTORY_DATABASE_URL',
  ),
  inventoryDatabaseConnectionTimeoutMs:
    getPositiveIntegerEnvironmentVariable(
      'INVENTORY_DATABASE_CONNECTION_TIMEOUT_MS',
    ),
});