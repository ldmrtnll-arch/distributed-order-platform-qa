import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testsDirectory, '..');
const localAddresses = '127.0.0.1,localhost';

process.env.NO_PROXY = [process.env.NO_PROXY, localAddresses]
  .filter(Boolean)
  .join(',');
process.env.no_proxy = [process.env.no_proxy, localAddresses]
  .filter(Boolean)
  .join(',');

export default defineConfig({
  testDir: './api',
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
  webServer: {
    command:
      'node --import tsx services/inventory-service/src/server.ts',
    cwd: repositoryRoot,
    port: 3002,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  globalSetup: './support/global-setup.ts',
  reporter: [['list']],
});
