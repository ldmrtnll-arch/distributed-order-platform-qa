import { Client, type QueryResultRow } from 'pg';

export async function queryInventoryDatabase<Row extends QueryResultRow>(
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<Row[]> {
  const connectionString = process.env.INVENTORY_DATABASE_URL;

  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error('INVENTORY_DATABASE_URL is required for database tests.');
  }

  const client = new Client({ connectionString });

  try {
    await client.connect();
    const result = await client.query<Row>(sql, [...parameters]);

    return result.rows;
  } finally {
    await client.end();
  }
}
