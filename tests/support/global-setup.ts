import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const testsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repositoryRoot = path.resolve(testsDirectory, '..');

config({
  path: path.join(repositoryRoot, '.env'),
});

export default async function globalSetup(): Promise<void> {
  const connectionString = process.env.INVENTORY_DATABASE_URL;

  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('INVENTORY_DATABASE_URL is required for API tests.');
  }

  const databaseDirectory = path.join(
    repositoryRoot,
    'services',
    'inventory-service',
    'database',
  );
  const [migration, seed] = await Promise.all([
    readFile(
      path.join(databaseDirectory, 'migrations', '001_create_products.sql'),
      'utf8',
    ),
    readFile(
      path.join(databaseDirectory, 'seeds', '001_seed_products.sql'),
      'utf8',
    ),
  ]);
  const client = new Client({ connectionString });

  try {
    await client.connect();
    await client.query(migration);
    await client.query(seed);
  } finally {
    await client.end();
  }
}
