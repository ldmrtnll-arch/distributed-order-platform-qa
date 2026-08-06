import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

config({
  path: [
    path.join(repositoryRoot, '.env'),
    path.join(repositoryRoot, '.env.example'),
  ],
  quiet: true,
});

export default async function paymentGlobalSetup(): Promise<void> {
  const connectionString = process.env.PAYMENT_DATABASE_URL;

  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('PAYMENT_DATABASE_URL is required for payment resilience.');
  }

  const migration = await readFile(
    path.join(
      repositoryRoot,
      'services',
      'payment-service',
      'database',
      'migrations',
      '001_create_payments.sql',
    ),
    'utf8',
  );
  const client = new Client({ connectionString });

  try {
    await client.connect();
    await client.query(migration);
    await client.query('DELETE FROM payments');
  } finally {
    await client.end();
  }
}
