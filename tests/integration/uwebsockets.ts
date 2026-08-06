import type { Handler, ServerRequest } from '@chubbyts/chubbyts-undici-server/dist/server';
import { Response } from '@chubbyts/chubbyts-undici-server/dist/server';
import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import { App } from 'uWebSockets.js';
import {
  createUWebSocketsRequestToUndiciRequestFactory,
  createUndiciResponseToUWebSocketsResponseEmitter,
} from '../../src/uwebsockets.js';

const serverHost = process.env.SERVER_HOST as string;
const serverPort = parseInt(process.env.SERVER_PORT as string);

const uWebSocketsRequestToUndiciRequestFactory = createUWebSocketsRequestToUndiciRequestFactory(
  'https://example.com',
  30_000,
);

const handler: Handler = async (serverRequest: ServerRequest): Promise<Response> => {
  if (new URL(serverRequest.url).pathname === '/path/to/error/route') {
    throw new Error('Handler failure');
  }

  const headers = Object.fromEntries(serverRequest.headers.entries());

  const { host: _, ...otherHeaders } = headers;

  return new Response(
    JSON.stringify({
      method: serverRequest.method,
      url: serverRequest.url,
      headers: otherHeaders,
      body: await serverRequest.text(),
    }),
    {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json' },
    },
  );
};

const undiciResponseToUWebSocketsResponseEmitter = createUndiciResponseToUWebSocketsResponseEmitter(60_000);

App()
  .any('/*', async (res: HttpResponse, req: HttpRequest) => {
    // oxlint-disable-next-line functional/no-let
    let serverRequest: ServerRequest | undefined = undefined;

    try {
      serverRequest = uWebSocketsRequestToUndiciRequestFactory(req, res);
      const response = await handler(serverRequest);
      undiciResponseToUWebSocketsResponseEmitter(response, res);
    } catch (error) {
      console.error(`Failed to handle request: ${error}`);

      // uWebSockets.js forbids touching an aborted response: if the client is already gone
      // there is nothing left to send the error response to
      if (serverRequest?.signal.aborted) {
        return;
      }

      res.cork(() => {
        res.writeStatus('500 Internal Server Error');
        res.writeHeader('content-type', 'text/plain');
        res.end('Internal Server Error');
      });
    }
  })
  .listen(serverHost, serverPort, (listenSocket: unknown) => {
    if (listenSocket) {
      console.log(`Listening to ${serverHost}:${serverPort}`);
    }
  });
