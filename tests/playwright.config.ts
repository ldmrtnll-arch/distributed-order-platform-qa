import { defineConfig } from '@playwright/test';
import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testsDirectory, '..');
const localAddresses = '127.0.0.1,localhost';

config({
  path: [
    path.join(repositoryRoot, '.env'),
    path.join(repositoryRoot, '.env.example'),
  ],
  quiet: true,
});

process.env.NO_PROXY = [process.env.NO_PROXY, localAddresses]
  .filter(Boolean)
  .join(',');
process.env.no_proxy = [process.env.no_proxy, localAddresses]
  .filter(Boolean)
  .join(',');

export default defineConfig({
  testDir: '.',
  testIgnore: '**/resilience/**',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  timeout: 10_000,
  use: {
    baseURL: 'http://127.0.0.1:3002',
    extraHTTPHeaders: {
      Accept: 'application/json',
    },
  },
  webServer: [
    {
      command:
        'node --import tsx services/inventory-service/src/server.ts',
      cwd: repositoryRoot,
      port: 3002,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'node --import tsx services/payment-service/src/server.ts',
      cwd: repositoryRoot,
      port: 3003,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'node --import tsx services/order-service/src/server.ts',
      cwd: repositoryRoot,
      env: {
        ...process.env,
        INVENTORY_SERVICE_URL: 'http://127.0.0.1:3002',
        INVENTORY_REQUEST_TIMEOUT_MS: '2000',
      },
      port: 3001,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
  globalSetup: './support/global-setup.ts',
  reporter: [['list']],
});
