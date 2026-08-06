# chubbyts-undici-server-uwebsockets

[![CI](https://github.com/chubbyts/chubbyts-undici-server-uwebsockets/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/chubbyts/chubbyts-undici-server-uwebsockets/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/chubbyts/chubbyts-undici-server-uwebsockets/badge.svg?branch=master)](https://coveralls.io/github/chubbyts/chubbyts-undici-server-uwebsockets?branch=master)
[![Mutation testing badge](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fchubbyts%2Fchubbyts-undici-server-uwebsockets%2Fmaster)](https://dashboard.stryker-mutator.io/reports/github.com/chubbyts/chubbyts-undici-server-uwebsockets/master)
[![npm-version](https://img.shields.io/npm/v/@chubbyts/chubbyts-undici-server-uwebsockets.svg)](https://www.npmjs.com/package/@chubbyts/chubbyts-undici-server-uwebsockets)

[![bugs](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-server-uwebsockets&metric=bugs)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-server-uwebsockets)
[![code_smells](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-server-uwebsockets&metric=code_smells)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-server-uwebsockets)
[![coverage](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-server-uwebsockets&metric=coverage)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-server-uwebsockets)
[![duplicated_lines_density](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-server-uwebsockets&metric=duplicated_lines_density)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-server-uwebsockets)
[![ncloc](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-server-uwebsockets&metric=ncloc)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-server-uwebsockets)
[![sqale_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-server-uwebsockets&metric=sqale_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-server-uwebsockets)
[![alert_status](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-server-uwebsockets&metric=alert_status)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-server-uwebsockets)
[![reliability_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-server-uwebsockets&metric=reliability_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-server-uwebsockets)
[![security_rating](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-server-uwebsockets&metric=security_rating)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-server-uwebsockets)
[![sqale_index](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-server-uwebsockets&metric=sqale_index)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-server-uwebsockets)
[![vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=chubbyts_chubbyts-undici-server-uwebsockets&metric=vulnerabilities)](https://sonarcloud.io/dashboard?id=chubbyts_chubbyts-undici-server-uwebsockets)

## Description

Use @chubbyts/chubbyts-undici-server on uwebsockets.

## Requirements

 * node: 22
 * [@chubbyts/chubbyts-undici-server][2]: ^1.2.0
 * [uWebSockets.js][3]: github:uNetworking/uWebSockets.js#v20.67.0

## Installation

Through [NPM](https://www.npmjs.com) as [@chubbyts/chubbyts-undici-server-uwebsockets][1].

```sh
npm i @chubbyts/chubbyts-undici-server-uwebsockets@^1.2.0
```

## Usage

```ts
import type { Handler, ServerRequest } from '@chubbyts/chubbyts-undici-server/dist/server';
import { Response } from '@chubbyts/chubbyts-undici-server/dist/server';
import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import { App } from 'uWebSockets.js';
import {
  createUWebSocketsRequestToUndiciRequestFactory,
  createUndiciResponseToUWebSocketsResponseEmitter,
} from '@chubbyts/chubbyts-undici-server-uwebsockets/dist/uwebsockets';

const serverHost = process.env.SERVER_HOST as string;
const serverPort = parseInt(process.env.SERVER_PORT as string);

// second argument (optional): the request body must be fully received within 30s
const uWebSocketsRequestToUndiciRequestFactory = createUWebSocketsRequestToUndiciRequestFactory('https://example.com', 30_000);

// for example @chubbyts/chubbyts-framework app (which implements Handler)
const handler: Handler = async (serverRequest: ServerRequest<{name: string}>): Promise<Response> => {
  return new Response(`Hello, ${serverRequest.attributes.name}`, {
    status: 200,
    statusText: STATUS_CODES[200],
    headers: {'content-type': 'text/plain'}
  });
};

// argument (optional): the response must be fully sent within 60s
const undiciResponseToUWebSocketsResponseEmitter = createUndiciResponseToUWebSocketsResponseEmitter(60_000);

App()
  .any('/*', async (res: HttpResponse, req: HttpRequest) => {
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
```

### Timeouts

Slow clients (slowloris) can otherwise tie up sockets indefinitely:

 * `createUWebSocketsRequestToUndiciRequestFactory(baseUrl, requestBodyTimeoutMs)`: if the request body has not
   been fully received within the given time, the connection gets closed and the error surfaces to the handler
   through the request body stream.
 * `createUndiciResponseToUWebSocketsResponseEmitter(responseSendTimeoutMs)`: if the response has not been fully
   sent within the given time (slow reading client or stalling response body stream), the connection gets closed.

Both timeouts are optional and disabled by default. They only cover the body phases handled by this adapter,
slow header senders are covered by the idle timeout uWebSockets.js applies to HTTP connections itself.

## Copyright

2026 Dominik Zogg

[1]: https://www.npmjs.com/package/@chubbyts/chubbyts-undici-server-uwebsockets
[2]: https://www.npmjs.com/package/@chubbyts/chubbyts-undici-server
[3]: https://github.com/uNetworking/uWebSockets.js
