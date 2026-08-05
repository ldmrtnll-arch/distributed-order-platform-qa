import { createApp } from './app.js';

const defaultPort = 3002;
const configuredPort = Number(process.env.PORT ?? defaultPort);

if (
  !Number.isInteger(configuredPort) ||
  configuredPort < 1 ||
  configuredPort > 65535
) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const app = createApp();

app.listen(configuredPort, '0.0.0.0', () => {
  console.log(
    JSON.stringify({
      level: 'info',
      service: 'inventory-service',
      message: 'HTTP server started',
      port: configuredPort,
    }),
  );
});