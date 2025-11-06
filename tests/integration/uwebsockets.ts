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

const uUWebSocketsRequestToUndiciRequestFactory = createUWebSocketsRequestToUndiciRequestFactory('https://example.com');

const handler: Handler = async (serverRequest: ServerRequest): Promise<Response> => {
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

const undiciResponseToUWebSocketsResponseEmitter = createUndiciResponseToUWebSocketsResponseEmitter();

App()
  .any('/*', async (res: HttpResponse, req: HttpRequest) => {
    undiciResponseToUWebSocketsResponseEmitter(await handler(uUWebSocketsRequestToUndiciRequestFactory(req, res)), res);
  })
  .listen(serverHost, serverPort, (listenSocket: unknown) => {
    if (listenSocket) {
      console.log(`Listening to ${serverHost}:${serverPort}`);
    }
  });
