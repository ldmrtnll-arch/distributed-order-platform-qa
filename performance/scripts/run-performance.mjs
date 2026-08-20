import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from 'dotenv';

import {
  cleanupPerformanceData,
  preparePerformanceData,
  verifyPerformanceConsistency,
} from './manage-test-data.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const artifactDirectory = path.join(repositoryRoot, 'artifacts', 'performance');
const scenarioFiles = {
  smoke: 'smoke.js',
  load: 'order-load.js',
  concurrency: 'order-concurrency.js',
};

config({
  path: [path.join(repositoryRoot, '.env'), path.join(repositoryRoot, '.env.example')],
  quiet: true,
});

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function assertPortsFree() {
  for (const port of [3001, 3002, 3003, 3004]) {
    const isOpen = await new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      const finish = (open) => {
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(300);
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
    });
    if (isOpen) throw new Error(`Port ${port} is already in use.`);
  }
}

function startService(name, entrypoint, environment = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', entrypoint], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => output.push(chunk));
  return { name, child, output };
}

async function waitForHealth(url, service, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (service.child.exitCode !== null) {
      throw new Error(`${service.name} exited before becoming healthy.`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return;
    } catch {
      // Bounded health polling intentionally ignores connection failures.
    }
    await wait(100);
  } while (Date.now() < deadline);
  throw new Error(`${service.name} did not become healthy.`);
}

async function stopService(service) {
  if (service.child.exitCode !== null) return;
  const exited = new Promise((resolve) => service.child.once('exit', resolve));
  service.child.kill('SIGTERM');
  await Promise.race([exited, wait(5000)]);
  if (service.child.exitCode === null) service.child.kill('SIGKILL');
}

async function runK6(scenario, runId) {
  const source = path.join(repositoryRoot, 'performance', 'scripts', scenarioFiles[scenario]);
  const containerSource = `/workspace/${path.relative(repositoryRoot, source).replaceAll('\\', '/')}`;
  const summary = `/workspace/artifacts/performance/${scenario}-summary.json`;
  const linuxNetworkArguments =
    process.platform === 'win32' ? [] : ['--network', 'host'];
  const baseUrl =
    process.platform === 'win32'
      ? 'http://host.docker.internal:3001'
      : 'http://127.0.0.1:3001';
  const arguments_ = [
    'run', '--rm',
    ...linuxNetworkArguments,
    '--mount', `type=bind,source=${repositoryRoot},target=/workspace`,
    '-e', `BASE_URL=${baseUrl}`,
    '-e', `PERF_RUN_ID=${runId}`,
    'grafana/k6:0.54.0',
    'run', '--summary-export', summary, containerSource,
  ];
  const child = spawn('docker', arguments_, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (exitCode !== 0) throw new Error(`K6 ${scenario} failed with exit code ${exitCode}.`);
}

async function main() {
  const scenario = process.argv[2];
  if (!(scenario in scenarioFiles)) throw new Error('Expected smoke, load, or concurrency.');
  await mkdir(artifactDirectory, { recursive: true });
  await assertPortsFree();
  await preparePerformanceData();
  const runId = `${scenario}-${Date.now()}`;
  const services = [];
  let consistency;
  try {
    services.push(startService('Inventory Service', 'services/inventory-service/src/server.ts'));
    services.push(startService('Payment Service', 'services/payment-service/src/server.ts'));
    services.push(startService('Notification Service', 'services/notification-service/src/server.ts'));
    await Promise.all([
      waitForHealth('http://127.0.0.1:3002/health', services[0]),
      waitForHealth('http://127.0.0.1:3003/health', services[1]),
      waitForHealth('http://127.0.0.1:3004/health', services[2]),
    ]);
    services.push(
      startService('Order Service', 'services/order-service/src/server.ts', {
        INVENTORY_SERVICE_URL: 'http://127.0.0.1:3002',
        INVENTORY_REQUEST_TIMEOUT_MS: '2000',
        PAYMENT_SERVICE_URL: 'http://127.0.0.1:3003',
        PAYMENT_REQUEST_TIMEOUT_MS: '2000',
      }),
    );
    await waitForHealth('http://127.0.0.1:3001/health', services[3]);
    await runK6(scenario, runId);
    consistency = await verifyPerformanceConsistency();
    console.log(`PERFORMANCE_CONSISTENCY ${JSON.stringify(consistency)}`);
  } finally {
    for (const service of [...services].reverse()) await stopService(service);
    await writeFile(
      path.join(artifactDirectory, `${scenario}-services.log`),
      services.map((service) => `## ${service.name}\n${service.output.join('')}`).join('\n'),
      'utf8',
    );
    await cleanupPerformanceData();
  }
}

await main();
