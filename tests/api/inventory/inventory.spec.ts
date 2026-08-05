import { expect, test, type APIResponse } from '@playwright/test';

interface InventoryItemResponse {
  sku: string;
  name: string;
  totalQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
}

const inventoryItemFields = [
  'availableQuantity',
  'name',
  'reservedQuantity',
  'sku',
  'totalQuantity',
];

async function expectInventoryItem(
  response: APIResponse,
  expected: Partial<InventoryItemResponse>,
): Promise<InventoryItemResponse> {
  expect(response.status()).toBe(200);

  const body = (await response.json()) as InventoryItemResponse;

  expect(Object.keys(body).sort()).toEqual(inventoryItemFields);
  expect(typeof body.sku).toBe('string');
  expect(typeof body.name).toBe('string');
  expect(typeof body.totalQuantity).toBe('number');
  expect(typeof body.reservedQuantity).toBe('number');
  expect(typeof body.availableQuantity).toBe('number');
  expect(body.availableQuantity).toBe(
    body.totalQuantity - body.reservedQuantity,
  );
  expect(body).toMatchObject(expected);

  return body;
}

test.describe('GET /inventory/:sku', () => {
  test('returns an existing product with stock and safe JSON headers', async ({
    request,
  }) => {
    const response = await request.get('/inventory/BOOK-001');

    expect(response.headers()['content-type']).toMatch(
      /^application\/json(?:;|$)/,
    );
    expect(response.headers()).not.toHaveProperty('x-powered-by');
    await expectInventoryItem(response, {
      sku: 'BOOK-001',
      name: 'Distributed Systems Fundamentals',
      totalQuantity: 10,
      reservedQuantity: 0,
      availableQuantity: 10,
    });
  });

  test('normalizes lowercase SKU letters', async ({ request }) => {
    const response = await request.get('/inventory/book-001');

    await expectInventoryItem(response, {
      sku: 'BOOK-001',
    });
  });

  test('removes encoded surrounding spaces from the SKU', async ({
    request,
  }) => {
    const response = await request.get('/inventory/%20book-001%20');

    await expectInventoryItem(response, {
      sku: 'BOOK-001',
    });
  });

  test('returns an existing product with zero stock', async ({ request }) => {
    const response = await request.get('/inventory/KEYBOARD-001');

    await expectInventoryItem(response, {
      sku: 'KEYBOARD-001',
      name: 'Mechanical Testing Keyboard',
      totalQuantity: 0,
      reservedQuantity: 0,
      availableQuantity: 0,
    });
  });

  test('returns the public error contract for an unknown SKU', async ({
    request,
  }) => {
    const response = await request.get('/inventory/UNKNOWN-001');

    expect(response.status()).toBe(404);
    expect(response.headers()['content-type']).toMatch(
      /^application\/json(?:;|$)/,
    );
    expect(response.headers()).not.toHaveProperty('x-powered-by');
    expect(await response.json()).toEqual({
      code: 'INVENTORY_ITEM_NOT_FOUND',
      message: 'Inventory item not found.',
      details: {
        sku: 'UNKNOWN-001',
      },
    });
  });
});
