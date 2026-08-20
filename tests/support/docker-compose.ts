import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ComposeServiceStatus {
  Health: string;
  State: string;
}

async function runDockerCompose(arguments_: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'docker',
    ['compose', ...arguments_],
    { encoding: 'utf8', windowsHide: true },
  );

  return stdout;
}

export async function stopPostgres(): Promise<void> {
  await runDockerCompose(['stop', 'postgres']);
}

export async function startPostgres(): Promise<void> {
  await runDockerCompose(['start', 'postgres']);
}

export async function getPostgresStatus(): Promise<ComposeServiceStatus> {
  return getComposeServiceStatus('postgres');
}

export async function getRabbitMqStatus(): Promise<ComposeServiceStatus> {
  return getComposeServiceStatus('rabbitmq');
}

export async function stopRabbitMq(): Promise<void> {
  await runDockerCompose(['stop', 'rabbitmq']);
}

export async function startRabbitMq(): Promise<void> {
  await runDockerCompose(['start', 'rabbitmq']);
}

async function getComposeServiceStatus(
  service: string,
): Promise<ComposeServiceStatus> {
  const output = await runDockerCompose([
    'ps',
    '--all',
    '--format',
    'json',
    service,
  ]);
  const trimmedOutput = output.trim();

  if (trimmedOutput === '') {
    return { Health: '', State: 'missing' };
  }

  const parsed: unknown = JSON.parse(trimmedOutput);
  const status = Array.isArray(parsed) ? parsed[0] : parsed;

  if (typeof status !== 'object' || status === null) {
    throw new Error(`Docker Compose returned an invalid ${service} status.`);
  }

  return {
    Health: String(Reflect.get(status, 'Health') ?? ''),
    State: String(Reflect.get(status, 'State') ?? ''),
  };
}
