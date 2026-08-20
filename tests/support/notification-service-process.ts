import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export interface NotificationServiceProcess {
  logs: () => string;
  isRunning: () => boolean;
  pid: number;
  stop: () => Promise<void>;
}

export function startNotificationService({
  port = 3004,
  rabbitMqUrl = 'amqp://qa_user:qa_password@127.0.0.1:5672/qa',
  reconnectIntervalMs = 200,
}: {
  port?: number;
  rabbitMqUrl?: string;
  reconnectIntervalMs?: number;
} = {}): NotificationServiceProcess {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['--import', 'tsx', 'services/notification-service/src/server.ts'],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NOTIFICATION_SERVICE_PORT: String(port),
        RABBITMQ_URL: rabbitMqUrl,
        ORDER_EVENTS_EXCHANGE: 'order.events',
        NOTIFICATION_RECONNECT_INTERVAL_MS: String(reconnectIntervalMs),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('Notification Service did not expose a process ID.');
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
