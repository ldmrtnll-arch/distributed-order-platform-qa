import { createApp } from './app.js';

const defaultPort = 3003;
const port = Number(process.env.PORT ?? defaultPort);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const app = createApp();

app.listen(port, '0.0.0.0', () => {
  console.log(
    JSON.stringify({
      level: 'info',
      service: 'payment-service',
      message: 'HTTP server started',
      port,
    }),
  );
});
