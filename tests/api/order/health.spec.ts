import { expect, test } from '@playwright/test';

test.describe('GET /health - Order Service', () => {
  test('returns the Order Service health status when the database is available', async ({
    request,
  }) => {
    const response = await request.get('http://127.0.0.1:3001/health');

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(
      /^application\/json(?:;|$)/,
    );
    expect(response.headers()).not.toHaveProperty('x-powered-by');
    const body = (await response.json()) as unknown;
    expect(body).toEqual({
      service: 'order-service',
      status: 'UP',
      dependencies: { database: 'UP' },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /password|postgres(?:ql)?|connectionstring|stack|\.env|\bsql\b|\bselect\b|orders|[a-z]:\\|\/services\/|node_modules|econnrefused/i,
    );
  });
});
