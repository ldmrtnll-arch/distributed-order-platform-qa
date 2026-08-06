import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const localAddresses = '127.0.0.1,localhost';

process.env.NO_PROXY = [process.env.NO_PROXY, localAddresses]
  .filter(Boolean)
  .join(',');
process.env.no_proxy = [process.env.no_proxy, localAddresses]
  .filter(Boolean)
  .join(',');

export default defineConfig({
  testDir: './resilience/payment',
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: 'http://127.0.0.1:3003',
    extraHTTPHeaders: { Accept: 'application/json' },
  },
  globalSetup: path.join(
    testsDirectory,
    'support',
    'payment-global-setup.ts',
  ),
  reporter: [['list']],
});
