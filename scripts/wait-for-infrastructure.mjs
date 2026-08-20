import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const timeoutMs = Number(process.env.INFRA_HEALTH_TIMEOUT_MS ?? 120000);
const deadline = Date.now() + timeoutMs;

async function health(service) {
  const { stdout } = await execFileAsync(
    'docker',
    ['compose', 'ps', '--all', '--format', 'json', service],
    { encoding: 'utf8', windowsHide: true },
  );
  const parsed = JSON.parse(stdout.trim());
  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  return String(item?.Health ?? '');
}

while (Date.now() < deadline) {
  const [postgres, rabbitmq] = await Promise.all([
    health('postgres'),
    health('rabbitmq'),
  ]);
  if (postgres === 'healthy' && rabbitmq === 'healthy') {
    console.log('PostgreSQL and RabbitMQ are healthy.');
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

throw new Error('Infrastructure did not become healthy before the timeout.');
