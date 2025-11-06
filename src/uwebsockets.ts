import { PassThrough, Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import type { Response } from '@chubbyts/chubbyts-undici-server/dist/server';
import { ServerRequest } from '@chubbyts/chubbyts-undici-server/dist/server';

export const getUrl = (uWebSocketsRequest: HttpRequest, baseUrl: string | undefined = undefined): string => {
  const query = uWebSocketsRequest.getQuery();
  const pathAndQuery = uWebSocketsRequest.getUrl() + (query ? `?${query}` : '');

  if (baseUrl) {
    return `${baseUrl}${pathAndQuery}`;
  }

  return `http://127.0.0.1${pathAndQuery}`;
};

type UWebSocketsRequestToUndiciRequestFactory = (
  uWebSocketsRequest: HttpRequest,
  uWebSocketsResponse: HttpResponse,
) => ServerRequest;

const getBody = (res: HttpResponse): ReadableStream => {
  const passthrough = new PassThrough();

  res.onData((chunk: ArrayBuffer, isLast: boolean) => {
    passthrough.write(Buffer.from(new Uint8Array(chunk)));

    if (isLast) {
      passthrough.end();
    }
  });

  return Readable.toWeb(passthrough);
};

export const createUWebSocketsRequestToUndiciRequestFactory = (
  baseUrl: string | undefined = undefined,
): UWebSocketsRequestToUndiciRequestFactory => {
  return (uWebSocketsRequest: HttpRequest, uWebSocketsResponse: HttpResponse): ServerRequest => {
    const method = uWebSocketsRequest.getMethod().toUpperCase();

    const headers = new Headers();

    uWebSocketsRequest.forEach((name, value) => {
      headers.append(name, value);
    });

    const hasBody = method !== 'GET' && method !== 'HEAD';
    const body = hasBody ? getBody(uWebSocketsResponse) : null;

    const abortController = new AbortController();

    uWebSocketsResponse.onAborted(() => {
      abortController.abort();
    });

    return new ServerRequest(getUrl(uWebSocketsRequest, baseUrl), {
      method,
      headers,
      body,
      duplex: hasBody ? 'half' : undefined,
      signal: abortController.signal,
    });
  };
};

type UndiciResponseToUWebSocketsResponseEmitter = (undiciResponse: Response, uWebSocketsResponse: HttpResponse) => void;

export const createUndiciResponseToUWebSocketsResponseEmitter = (): UndiciResponseToUWebSocketsResponseEmitter => {
  return (undiciResponse: Response, uWebSocketsResponse: HttpResponse): void => {
    uWebSocketsResponse.cork(() => {
      uWebSocketsResponse.writeStatus(`${undiciResponse.status} ${undiciResponse.statusText}`);

      Array.from(undiciResponse.headers.entries())
        .filter(([name]) => name.toLowerCase() !== 'set-cookie')
        .forEach(([name, value]) => {
          uWebSocketsResponse.writeHeader(name, value);
        });

      undiciResponse.headers.getSetCookie().forEach((value) => {
        uWebSocketsResponse.writeHeader('set-cookie', value);
      });
    });

    if (!undiciResponse.body) {
      uWebSocketsResponse.cork(() => {
        uWebSocketsResponse.endWithoutBody();
      });

      return;
    }

    const body = Readable.fromWeb(undiciResponse.body);

    body.on('data', (data) => {
      uWebSocketsResponse.cork(() => {
        uWebSocketsResponse.write(data);
      });
    });

    body.on('error', () =>
      uWebSocketsResponse.cork(() => {
        uWebSocketsResponse.end();
      }),
    );

    body.on('end', () =>
      uWebSocketsResponse.cork(() => {
        uWebSocketsResponse.end();
      }),
    );
  };
};
