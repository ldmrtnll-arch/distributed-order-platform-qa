import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

export interface ObservedPaymentRequest {
  body: string;
  headers: IncomingHttpHeaders;
  method: string | undefined;
  url: string | undefined;
}

interface PaymentMockResponse {
  body: unknown;
  delayMs?: number;
  status: number;
}

export interface PaymentMockServer {
  requests: () => readonly ObservedPaymentRequest[];
  stop: () => Promise<void>;
}

export async function startPaymentMockServer({
  port = 3003,
  response,
}: {
  port?: number;
  response: PaymentMockResponse;
}): Promise<PaymentMockServer> {
  const observedRequests: ObservedPaymentRequest[] = [];
  const pendingTimers = new Set<NodeJS.Timeout>();
  const server: Server = createServer((request, serverResponse) => {
    const bodyChunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    request.on('end', () => {
      observedRequests.push({
        body: Buffer.concat(bodyChunks).toString('utf8'),
        headers: request.headers,
        method: request.method,
        url: request.url,
      });

      const sendResponse = (): void => {
        serverResponse.statusCode = response.status;
        serverResponse.setHeader('Content-Type', 'application/json');
        serverResponse.end(JSON.stringify(response.body));
      };

      if (response.delayMs === undefined) {
        sendResponse();
        return;
      }

      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        if (!serverResponse.destroyed) sendResponse();
      }, response.delayMs);
      pendingTimers.add(timer);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    requests: () => observedRequests,
    stop: async () => {
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
        server.closeAllConnections();
      });
    },
  };
}
