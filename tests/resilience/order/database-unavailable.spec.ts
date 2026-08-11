import { expect, test, type APIResponse } from '@playwright/test';

import {
  getPostgresStatus,
  getRabbitMqStatus,
  startPostgres,
  stopPostgres,
} from '../../support/docker-compose.js';
import { isPortReachable } from '../../support/inventory-service-process.js';
import {
  isOrderPortReachable,
  startOrderService,
} from '../../support/order-service-process.js';

interface ServiceLog {
  errorCode?: string;
  errorName?: string;
  level?: string;
  message?: string;
  operation?: string;
  service?: string;
}

const healthyBody = {
  service: 'order-service',
  status: 'UP',
  dependencies: { database: 'UP' },
};
const degradedBody = {
  service: 'order-service',
  status: 'DEGRADED',
  dependencies: { database: 'DOWN' },
};

async function expectHealth(
  response: APIResponse,
  status: number,
  body: unknown,
): Promise<void> {
  expect(response.status()).toBe(status);
  expect(response.headers()['content-type']).toMatch(
    /^application\/json(?:;|$)/,
  );
  expect(response.headers()).not.toHaveProperty('x-powered-by');
  const responseBody = (await response.json()) as unknown;
  expect(responseBody).toEqual(body);
  expect(JSON.stringify(responseBody)).not.toMatch(
    /qa_password|postgres(?:ql)?|connectionstring|stack|\.env|\bsql\b|\bselect\b|127\.0\.0\.1:5433|localhost:5433|[a-z]:\\|\/services\/|node_modules|econnrefused/i,
  );
}

function parseLogs(rawLogs: string): ServiceLog[] {
  return rawLogs
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ServiceLog);
}

test('returns 503 during a database outage and recovers without restarting', async ({
  request,
}) => {
  await expect.poll(async () => (await getPostgresStatus()).Health).toBe('healthy');
  await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');

  const serviceProcess = startOrderService();
  const initialPid = serviceProcess.pid;
  console.log(
    JSON.stringify({ phase: 'initial', pid: initialPid, isRunning: true }),
  );

  try {
    await expect.poll(() => isOrderPortReachable()).toBe(true);
    await expectHealth(await request.get('/health'), 200, healthyBody);
    expect(serviceProcess.isRunning()).toBe(true);

    await stopPostgres();
    await expect
      .poll(async () => (await getPostgresStatus()).State.toLowerCase())
      .toMatch(/exited|stopped/u);
    await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);
    console.log(
      JSON.stringify({
        phase: 'database-outage',
        pid: serviceProcess.pid,
        isRunning: serviceProcess.isRunning(),
      }),
    );

    await expectHealth(await request.get('/health'), 503, degradedBody);
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);

    await expect
      .poll(() =>
        parseLogs(serviceProcess.logs()).some(
          (entry) =>
            entry.level === 'error' &&
            entry.service === 'order-service' &&
            (entry.operation === 'postgres-pool' ||
              entry.operation === 'database-health-check'),
        ),
      )
      .toBe(true);
    const errorLogs = parseLogs(serviceProcess.logs()).filter(
      (entry) => entry.level === 'error',
    );
    expect(errorLogs.length).toBeGreaterThan(0);
    for (const errorLog of errorLogs) {
      expect(errorLog.service).toBe('order-service');
      expect(errorLog.operation).toMatch(
        /^(?:postgres-pool|database-health-check)$/u,
      );
      expect(errorLog.message).toEqual(expect.any(String));
    }
    expect(JSON.stringify(errorLogs)).not.toMatch(
      /ORDER_DATABASE_URL|qa_password|postgresql:\/\/|connectionstring|stack|\.env|SELECT 1|127\.0\.0\.1:5433|localhost:5433/i,
    );

    await startPostgres();
    await expect.poll(async () => (await getPostgresStatus()).Health).toBe('healthy');
    await expect
      .poll(async () => {
        try {
          const response = await request.get('/health');
          return response.status() === 200 ? response.json() : null;
        } catch {
          return null;
        }
      })
      .toEqual(healthyBody);
    await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');
    expect(serviceProcess.isRunning()).toBe(true);
    expect(serviceProcess.pid).toBe(initialPid);
    await expectHealth(await request.get('/health'), 200, healthyBody);
    console.log(
      JSON.stringify({
        phase: 'recovered',
        pid: serviceProcess.pid,
        isRunning: serviceProcess.isRunning(),
      }),
    );
  } finally {
    await startPostgres();
    await expect.poll(async () => (await getPostgresStatus()).Health).toBe('healthy');
    await expect.poll(async () => (await getRabbitMqStatus()).Health).toBe('healthy');
    await serviceProcess.stop();
    await expect.poll(() => isOrderPortReachable()).toBe(false);
    await expect.poll(() => isPortReachable(3002)).toBe(false);
    await expect.poll(() => isPortReachable(3003)).toBe(false);
  }
});
