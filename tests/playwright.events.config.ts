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
  testDir: './events',
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: 'http://127.0.0.1:3001',
    extraHTTPHeaders: { Accept: 'application/json' },
  },
  globalSetup: path.join(testsDirectory, 'support', 'events-global-setup.ts'),
  reporter: [['list']],
});
