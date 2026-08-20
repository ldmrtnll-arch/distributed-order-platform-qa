import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export interface PaymentServiceProcess {
  logs: () => string;
  isRunning: () => boolean;
  pid: number;
  stop: () => Promise<void>;
}

interface StartPaymentServiceOptions {
  port?: number;
}

export function startPaymentService(
  options: StartPaymentServiceOptions = {},
): PaymentServiceProcess {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['--import', 'tsx', 'services/payment-service/src/server.ts'],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PORT: String(options.port ?? 3003),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const pid = child.pid;

  if (pid === undefined) {
    throw new Error('Payment Service did not expose a process ID.');
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
