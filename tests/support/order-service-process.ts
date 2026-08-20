import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export interface OrderServiceProcess {
  logs: () => string;
  isRunning: () => boolean;
  pid: number;
  stop: () => Promise<void>;
}

interface StartOrderServiceOptions {
  inventoryRequestTimeoutMs?: number;
  inventoryServiceUrl?: string;
}

export function startOrderService(
  options: StartOrderServiceOptions = {},
): OrderServiceProcess {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['--import', 'tsx', 'services/order-service/src/server.ts'],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ORDER_SERVICE_PORT: '3001',
        INVENTORY_SERVICE_URL:
          options.inventoryServiceUrl ?? 'http://127.0.0.1:3002',
        INVENTORY_REQUEST_TIMEOUT_MS: String(
          options.inventoryRequestTimeoutMs ?? 2000,
        ),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const pid = child.pid;

  if (pid === undefined) {
    throw new Error('Order Service did not expose a process ID.');
  }

  const output: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => output.push(chunk));
  child.stderr.on('data', (chunk: string) => output.push(chunk));

  return {
    pid,
    logs: () => output.join(''),
    isRunning: () => child.exitCode === null,
    stop: async () => {
      if (child.exitCode !== null) return;

      const exited = new Promise<void>((resolve, reject) => {
        child.once('exit', () => resolve());
        child.once('error', reject);
      });
      child.kill('SIGTERM');
      await exited;
    },
  };
}

export async function isOrderPortReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 3001 });
    socket.setTimeout(250);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}
