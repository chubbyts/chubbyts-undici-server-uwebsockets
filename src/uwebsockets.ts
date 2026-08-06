import { PassThrough, Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import type { Response } from '@chubbyts/chubbyts-undici-server/dist/server';
import { ServerRequest } from '@chubbyts/chubbyts-undici-server/dist/server';

type AbortState = { aborted: boolean; listeners: Array<() => void> };

const abortStates = new WeakMap<HttpResponse, AbortState>();

// uWebSockets.js supports only a single onAborted callback per response, but the request
// factory and the response emitter both need to observe the abort: register it once and
// fan out to all interested listeners
const getAbortState = (uWebSocketsResponse: HttpResponse): AbortState => {
  const existingState = abortStates.get(uWebSocketsResponse);

  if (existingState) {
    return existingState;
  }

  const state: AbortState = { aborted: false, listeners: [] };

  abortStates.set(uWebSocketsResponse, state);

  uWebSocketsResponse.onAborted(() => {
    // oxlint-disable-next-line functional/immutable-data
    state.aborted = true;
    state.listeners.forEach((listener) => listener());
  });

  return state;
};

const addAbortListener = (state: AbortState, listener: () => void): void => {
  if (state.aborted) {
    listener();

    return;
  }

  // oxlint-disable-next-line functional/immutable-data
  state.listeners.push(listener);
};

const resolveUrl = (pathAndQuery: string, base: string): string => {
  const parsedBase = new URL(base);
  const url = new URL(parsedBase.pathname.replace(/\/$/, '') + pathAndQuery, parsedBase.origin);

  // protocol-relative ('//evil.com/path') and backslash ('/\evil.com/path') targets resolve
  // to a different host than the base url and must not be trusted
  if (url.origin !== parsedBase.origin) {
    throw new Error(
      `Request target "${pathAndQuery}" resolves to origin "${url.origin}" instead of the expected origin "${parsedBase.origin}"`,
    );
  }

  return url.toString();
};

export const getUrl = (uWebSocketsRequest: HttpRequest, baseUrl: string | undefined = undefined): string => {
  const query = uWebSocketsRequest.getQuery();
  const pathAndQuery = uWebSocketsRequest.getUrl() + (query ? `?${query}` : '');

  // only origin-form request targets can be safely appended after a host: absolute-form
  // ('http://evil.com/path'), authority-form and asterisk-form targets would end up within
  // the authority part of the built url and allow host spoofing
  if (!pathAndQuery.startsWith('/')) {
    throw new Error(`Unsupported request target "${pathAndQuery}": only origin-form (starting with "/") is supported`);
  }

  return resolveUrl(pathAndQuery, baseUrl ?? 'http://127.0.0.1');
};

const uWebSocketsRequestToUndiciHeadersInit = (uWebSocketsRequest: HttpRequest): Array<[string, string]> => {
  const headers: Array<[string, string]> = [];

  uWebSocketsRequest.forEach((name, value) => {
    // oxlint-disable-next-line functional/immutable-data
    headers.push([name, value]);
  });

  return headers;
};

const getBody = (uWebSocketsResponse: HttpResponse, abortState: AbortState): ReadableStream => {
  const passthrough = new PassThrough();

  // a disconnecting client would otherwise leave the passthrough open forever: a pending
  // read of the request body has to fail instead of hanging
  addAbortListener(abortState, () => {
    passthrough.destroy(new Error('Request has been aborted'));
  });

  uWebSocketsResponse.onData((chunk: ArrayBuffer, isLast: boolean) => {
    passthrough.write(Buffer.from(new Uint8Array(chunk)));

    if (isLast) {
      passthrough.end();
    }
  });

  return Readable.toWeb(passthrough);
};

type UWebSocketsRequestToUndiciRequestFactory = (
  uWebSocketsRequest: HttpRequest,
  uWebSocketsResponse: HttpResponse,
) => ServerRequest;

export const createUWebSocketsRequestToUndiciRequestFactory = (
  baseUrl: string | undefined = undefined,
): UWebSocketsRequestToUndiciRequestFactory => {
  return (uWebSocketsRequest: HttpRequest, uWebSocketsResponse: HttpResponse): ServerRequest => {
    const method = uWebSocketsRequest.getMethod().toUpperCase();
    const headers = uWebSocketsRequestToUndiciHeadersInit(uWebSocketsRequest);
    const url = getUrl(uWebSocketsRequest, baseUrl);

    const abortState = getAbortState(uWebSocketsResponse);

    const abortController = new AbortController();

    addAbortListener(abortState, () => {
      abortController.abort();
    });

    if (method === 'GET' || method === 'HEAD') {
      return new ServerRequest(url, {
        method,
        headers,
        signal: abortController.signal,
      });
    }

    return new ServerRequest(url, {
      method,
      headers,
      body: getBody(uWebSocketsResponse, abortState),
      duplex: 'half',
      signal: abortController.signal,
    });
  };
};

const undiciResponseToUWebSocketsHeaders = (undiciResponse: Response): Array<[string, string]> => {
  const headers: Array<[string, string]> = [];

  for (const [name, value] of undiciResponse.headers.entries()) {
    if (name !== 'set-cookie') {
      // oxlint-disable-next-line functional/immutable-data
      headers.push([name, value]);
    }
  }

  for (const value of undiciResponse.headers.getSetCookie()) {
    // oxlint-disable-next-line functional/immutable-data
    headers.push(['set-cookie', value]);
  }

  return headers;
};

type UndiciResponseToUWebSocketsResponseEmitter = (undiciResponse: Response, uWebSocketsResponse: HttpResponse) => void;

export const createUndiciResponseToUWebSocketsResponseEmitter = (): UndiciResponseToUWebSocketsResponseEmitter => {
  return (undiciResponse: Response, uWebSocketsResponse: HttpResponse): void => {
    const abortState = getAbortState(uWebSocketsResponse);

    // the client may already be gone (uWebSockets.js forbids touching an aborted response):
    // cancel the potentially connection-backed body, nothing can be sent to the client anymore
    if (abortState.aborted) {
      undiciResponse.body?.cancel().catch(() => {});

      return;
    }

    const headers = undiciResponseToUWebSocketsHeaders(undiciResponse);

    if (!undiciResponse.body) {
      uWebSocketsResponse.cork(() => {
        uWebSocketsResponse.writeStatus(`${undiciResponse.status} ${undiciResponse.statusText}`);

        headers.forEach(([name, value]) => {
          uWebSocketsResponse.writeHeader(name, value);
        });

        uWebSocketsResponse.end();
      });

      return;
    }

    uWebSocketsResponse.cork(() => {
      uWebSocketsResponse.writeStatus(`${undiciResponse.status} ${undiciResponse.statusText}`);

      headers.forEach(([name, value]) => {
        uWebSocketsResponse.writeHeader(name, value);
      });
    });

    const body = Readable.fromWeb(undiciResponse.body);

    // a disconnecting client must stop the streaming: destroying the body stream also cancels
    // the underlying web stream
    addAbortListener(abortState, () => {
      body.destroy(new Error('Response has been aborted'));
    });

    body.on('data', (data: Buffer) => {
      uWebSocketsResponse.cork(() => {
        // write returns false on backpressure: pause the body stream until the client is
        // able to receive more data
        if (!uWebSocketsResponse.write(data)) {
          body.pause();

          uWebSocketsResponse.onWritable(() => {
            body.resume();

            return true;
          });
        }
      });
    });

    // an already started response cannot signal a failure anymore: close the connection
    // instead of ending the response as if it was complete
    body.on('error', () => {
      if (!abortState.aborted) {
        uWebSocketsResponse.close();
      }
    });

    body.on('end', () => {
      uWebSocketsResponse.cork(() => {
        uWebSocketsResponse.end();
      });
    });
  };
};
