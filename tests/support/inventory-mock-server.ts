import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

export interface ObservedInventoryRequest {
  body: string;
  headers: IncomingHttpHeaders;
  method: string | undefined;
  url: string | undefined;
}

interface InventoryMockResponse {
  body: unknown;
  delayMs?: number;
  status: number;
}

export interface InventoryMockServer {
  requests: () => readonly ObservedInventoryRequest[];
  stop: () => Promise<void>;
}

export async function startInventoryMockServer({
  port = 3002,
  response,
}: {
  port?: number;
  response: InventoryMockResponse;
}): Promise<InventoryMockServer> {
  const observedRequests: ObservedInventoryRequest[] = [];
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
