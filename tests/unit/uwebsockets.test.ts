import { describe, expect, test } from 'vitest';
import type { HttpRequest, HttpResponse } from 'uWebSockets.js';
import { Response } from '@chubbyts/chubbyts-undici-server/dist/server';
import {
  createUndiciResponseToUWebSocketsResponseEmitter,
  createUWebSocketsRequestToUndiciRequestFactory,
  getUrl,
} from '../../src/uwebsockets.js';

const mockUWebSocketsRequest = ({
  method,
  url,
  query,
  headers,
}: {
  method: string;
  url: string;
  query: string;
  headers: Array<[string, string]>;
}) => {
  return {
    getMethod: () => method,
    getUrl: () => url,
    getQuery: () => query,
    forEach: (callback) => {
      headers.forEach(([name, value]) => callback(name, value));
    },
  } as HttpRequest;
};

const makeErroringWebStream = (): ReadableStream<Uint8Array> => {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('hello'));
      setTimeout(() => {
        controller.error(new Error('boom'));
      }, 1);
    },
  });
};

const makeStallingWebStream = (onCancel?: (reason: unknown) => void): ReadableStream<Uint8Array> => {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('partial'));
      // stays open: never closes and never enqueues again
    },
    cancel(reason) {
      onCancel?.(reason);
    },
  });
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type MockUWebSocketsResponse = HttpResponse & {
  status: string | undefined;
  headers: Array<[string, string]>;
  chunks: Array<string>;
  ended: boolean;
  closed: boolean;
  triggerAbort: () => void;
  triggerData: (chunk: string, isLast: boolean) => void;
  triggerWritable: () => boolean;
};

const mockUWebSocketsResponse = (
  options: {
    body?: string;
    stallBody?: boolean;
    abort?: boolean;
    writeReturnValues?: Array<boolean>;
  } = {},
): MockUWebSocketsResponse => {
  const { body, stallBody = false, abort = false, writeReturnValues = [] } = options;

  // oxlint-disable-next-line functional/no-let
  let onAbortedCallback: (() => void) | undefined;

  // oxlint-disable-next-line functional/no-let
  let onDataCallback: ((chunk: ArrayBuffer, isLast: boolean) => void) | undefined;

  // oxlint-disable-next-line functional/no-let
  let onWritableCallback: ((offset: number) => boolean) | undefined;

  const response = {
    status: undefined as string | undefined,
    headers: [] as Array<[string, string]>,
    chunks: [] as Array<string>,
    ended: false,
    closed: false,
    onData: (callback: (chunk: ArrayBuffer, isLast: boolean) => void) => {
      onDataCallback = callback;

      if (stallBody) {
        return;
      }

      if (undefined === body) {
        throw new Error('no body');
      }

      const bodyLength = body.length;

      // oxlint-disable-next-line functional/no-let
      let start = 0;
      // oxlint-disable-next-line functional/no-let
      let end;
      // oxlint-disable-next-line functional/no-let
      let isLast;

      while (true) {
        end = start + Math.ceil(Math.random() * (bodyLength - start));

        isLast = end === bodyLength;

        callback(new TextEncoder().encode(body.substring(start, end)).buffer as ArrayBuffer, isLast);

        if (isLast) {
          return;
        }

        start = end;
      }
    },
    onAborted: (callback: () => void) => {
      onAbortedCallback = callback;

      if (abort) {
        callback();
      }
    },
    onWritable: (callback: (offset: number) => boolean) => {
      onWritableCallback = callback;
    },
    cork: (callback: () => void) => {
      callback();
    },
    writeStatus: (status: string) => {
      // oxlint-disable-next-line functional/immutable-data
      response.status = status;
    },
    writeHeader: (name: string, value: string) => {
      // oxlint-disable-next-line functional/immutable-data
      response.headers.push([name, value]);
    },
    write: (chunk: Buffer) => {
      // oxlint-disable-next-line functional/immutable-data
      response.chunks.push(chunk.toString());

      // oxlint-disable-next-line functional/immutable-data
      return writeReturnValues.length > 0 ? (writeReturnValues.shift() as boolean) : true;
    },
    end: () => {
      // oxlint-disable-next-line functional/immutable-data
      response.ended = true;
    },
    close: () => {
      // oxlint-disable-next-line functional/immutable-data
      response.closed = true;

      onAbortedCallback?.();
    },
    triggerAbort: () => {
      onAbortedCallback?.();
    },
    triggerData: (chunk: string, isLast: boolean) => {
      onDataCallback?.(new TextEncoder().encode(chunk).buffer as ArrayBuffer, isLast);
    },
    triggerWritable: () => onWritableCallback?.(0) ?? false,
  };

  return response as unknown as MockUWebSocketsResponse;
};

describe('uwebsockets', () => {
  describe('getUrl', () => {
    test('without base url without query', () => {
      const uWebSocketsRequest = {
        getUrl: () => '/',
        getQuery: () => '',
      } as HttpRequest;

      expect(getUrl(uWebSocketsRequest)).toMatchInlineSnapshot('"http://127.0.0.1/"');
    });

    test('without base url with query', () => {
      const uWebSocketsRequest = {
        getUrl: () => '/path/to/endpoint',
        getQuery: () => 'key=value',
      } as HttpRequest;

      expect(getUrl(uWebSocketsRequest)).toMatchInlineSnapshot('"http://127.0.0.1/path/to/endpoint?key=value"');
    });

    test('with base url without query', () => {
      const uWebSocketsRequest = {
        getUrl: () => '/',
        getQuery: () => '',
      } as HttpRequest;

      expect(getUrl(uWebSocketsRequest, 'https://example.com')).toMatchInlineSnapshot('"https://example.com/"');
    });

    test('with base url with query', () => {
      const uWebSocketsRequest = {
        getUrl: () => '/path/to/endpoint',
        getQuery: () => 'key=value',
      } as HttpRequest;

      expect(getUrl(uWebSocketsRequest, 'https://example.com')).toMatchInlineSnapshot(
        '"https://example.com/path/to/endpoint?key=value"',
      );
    });

    test('with base url, with trailing slash', () => {
      const uWebSocketsRequest = {
        getUrl: () => '/path/to/endpoint',
        getQuery: () => '',
      } as HttpRequest;

      expect(getUrl(uWebSocketsRequest, 'https://example.com/')).toMatchInlineSnapshot(
        '"https://example.com/path/to/endpoint"',
      );
    });

    test('with base url, with path prefix', () => {
      const uWebSocketsRequest = {
        getUrl: () => '/path/to/endpoint',
        getQuery: () => '',
      } as HttpRequest;

      expect(getUrl(uWebSocketsRequest, 'https://example.com/app')).toMatchInlineSnapshot(
        '"https://example.com/app/path/to/endpoint"',
      );
    });

    test('with base url, with path prefix, with trailing slash', () => {
      const uWebSocketsRequest = {
        getUrl: () => '/path/to/endpoint',
        getQuery: () => '',
      } as HttpRequest;

      expect(getUrl(uWebSocketsRequest, 'https://example.com/app/')).toMatchInlineSnapshot(
        '"https://example.com/app/path/to/endpoint"',
      );
    });

    test('with base url, with protocol-relative request target', () => {
      const uWebSocketsRequest = {
        getUrl: () => '//evil.com/path/to/endpoint',
        getQuery: () => '',
      } as HttpRequest;

      expect(() => getUrl(uWebSocketsRequest, 'https://example.com')).toThrow(
        'Request target "//evil.com/path/to/endpoint" resolves to origin "https://evil.com" instead of the expected origin "https://example.com"',
      );
    });

    test('with base url, with backslash protocol-relative request target', () => {
      const uWebSocketsRequest = {
        getUrl: () => '/\\evil.com/path/to/endpoint',
        getQuery: () => '',
      } as HttpRequest;

      expect(() => getUrl(uWebSocketsRequest, 'https://example.com')).toThrow(
        'Request target "/\\evil.com/path/to/endpoint" resolves to origin "https://evil.com" instead of the expected origin "https://example.com"',
      );
    });

    test('with base url, with absolute-form request target', () => {
      const uWebSocketsRequest = {
        getUrl: () => 'http://evil.com/path/to/endpoint',
        getQuery: () => '',
      } as HttpRequest;

      expect(() => getUrl(uWebSocketsRequest, 'https://example.com')).toThrow(
        'Unsupported request target "http://evil.com/path/to/endpoint": only origin-form (starting with "/") is supported',
      );
    });

    test('without base url, with authority-form request target', () => {
      const uWebSocketsRequest = {
        getUrl: () => 'evil.com:443',
        getQuery: () => '',
      } as HttpRequest;

      expect(() => getUrl(uWebSocketsRequest)).toThrow(
        'Unsupported request target "evil.com:443": only origin-form (starting with "/") is supported',
      );
    });

    test('without base url, with asterisk-form request target', () => {
      const uWebSocketsRequest = {
        getUrl: () => '*',
        getQuery: () => '',
      } as HttpRequest;

      expect(() => getUrl(uWebSocketsRequest)).toThrow(
        'Unsupported request target "*": only origin-form (starting with "/") is supported',
      );
    });
  });

  describe('createUWebSocketsRequestToUndiciRequestFactory', () => {
    test('get', async () => {
      const uWebSocketsRequest = mockUWebSocketsRequest({
        method: 'get',
        url: '/path/to/endpoint',
        query: 'key=value',
        headers: [['accept', 'application/json']],
      });

      const uWebSocketsResponse = mockUWebSocketsResponse({ abort: true });

      const uWebSocketsRequestToUndiciRequestFactory =
        createUWebSocketsRequestToUndiciRequestFactory('https://example.com');

      const serverRequest = uWebSocketsRequestToUndiciRequestFactory(uWebSocketsRequest, uWebSocketsResponse);

      expect(serverRequest.method).toBe('GET');
      expect(serverRequest.url).toBe('https://example.com/path/to/endpoint?key=value');
      expect(Object.fromEntries(serverRequest.headers.entries())).toMatchInlineSnapshot(`
        {
          "accept": "application/json",
        }
      `);

      expect(serverRequest.signal.aborted).toBe(true);

      expect(await serverRequest.text()).toBe('');
    });

    test('head', async () => {
      const uWebSocketsRequest = mockUWebSocketsRequest({
        method: 'head',
        url: '/path/to/endpoint',
        query: 'key=value',
        headers: [['accept', 'application/json']],
      });

      const uWebSocketsResponse = mockUWebSocketsResponse({});

      const uWebSocketsRequestToUndiciRequestFactory =
        createUWebSocketsRequestToUndiciRequestFactory('https://example.com');

      const serverRequest = uWebSocketsRequestToUndiciRequestFactory(uWebSocketsRequest, uWebSocketsResponse);

      expect(serverRequest.method).toBe('HEAD');
      expect(serverRequest.url).toBe('https://example.com/path/to/endpoint?key=value');
      expect(Object.fromEntries(serverRequest.headers.entries())).toMatchInlineSnapshot(`
        {
          "accept": "application/json",
        }
      `);

      expect(serverRequest.signal.aborted).toBe(false);

      expect(serverRequest.body).toBeNull();
    });

    test('post', async () => {
      const uWebSocketsRequest = mockUWebSocketsRequest({
        method: 'post',
        url: '/path/to/endpoint',
        query: 'key=value',
        headers: [
          ['content-type', 'multipart/form-data; boundary=WebKitFormBoundary7MA4YWxkTrZu0gW'],
          ['accept', 'application/json'],
        ],
      });

      const uWebSocketsResponse = mockUWebSocketsResponse({
        body: [
          '--WebKitFormBoundary7MA4YWxkTrZu0gW',
          'Content-Disposition: form-data; name="textField"',
          '',
          'example text',
          '--WebKitFormBoundary7MA4YWxkTrZu0gW',
          'Content-Disposition: form-data; name="fileField"; filename="red.png"',
          'Content-Type: image/png',
          'Content-Transfer-Encoding: base64',
          '',
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z/C/HwAF/gJ+QqzUAAAAAElFTkSuQmCC',
          '--WebKitFormBoundary7MA4YWxkTrZu0gW--',
        ].join('\r\n'),
      });

      const uWebSocketsRequestToUndiciRequestFactory =
        createUWebSocketsRequestToUndiciRequestFactory('https://example.com');

      const serverRequest = uWebSocketsRequestToUndiciRequestFactory(uWebSocketsRequest, uWebSocketsResponse);

      expect(serverRequest.method).toBe('POST');
      expect(serverRequest.url).toBe('https://example.com/path/to/endpoint?key=value');
      expect(Object.fromEntries(serverRequest.headers.entries())).toMatchInlineSnapshot(`
        {
          "accept": "application/json",
          "content-type": "multipart/form-data; boundary=WebKitFormBoundary7MA4YWxkTrZu0gW",
        }
      `);

      expect(serverRequest.signal.aborted).toBe(false);

      expect(serverRequest.body).not.toBeNull();

      const formData = await serverRequest.formData();

      expect(formData.has('textField')).toBe(true);

      const textField = formData.get('textField');

      expect(typeof textField).toBe('string');

      expect(formData.has('fileField')).toBe(true);

      const fileField = formData.get('fileField');

      expect(fileField).toBeInstanceOf(File);

      expect((fileField as File).name).toBe('red.png');
      expect((fileField as File).size).toBe(69);
    });

    test('post, with abort while receiving the body', async () => {
      const uWebSocketsRequest = mockUWebSocketsRequest({
        method: 'post',
        url: '/path/to/endpoint',
        query: '',
        headers: [['content-type', 'text/plain']],
      });

      const uWebSocketsResponse = mockUWebSocketsResponse({ stallBody: true });

      const uWebSocketsRequestToUndiciRequestFactory =
        createUWebSocketsRequestToUndiciRequestFactory('https://example.com');

      const serverRequest = uWebSocketsRequestToUndiciRequestFactory(uWebSocketsRequest, uWebSocketsResponse);

      uWebSocketsResponse.triggerAbort();

      expect(serverRequest.signal.aborted).toBe(true);

      await expect(serverRequest.text()).rejects.toThrow('Request has been aborted');
    });

    test('with absolute-form request target', () => {
      const uWebSocketsRequest = mockUWebSocketsRequest({
        method: 'get',
        url: 'http://evil.com/path/to/endpoint',
        query: '',
        headers: [],
      });

      const uWebSocketsResponse = mockUWebSocketsResponse({});

      const uWebSocketsRequestToUndiciRequestFactory =
        createUWebSocketsRequestToUndiciRequestFactory('https://example.com');

      expect(() => uWebSocketsRequestToUndiciRequestFactory(uWebSocketsRequest, uWebSocketsResponse)).toThrow(
        'Unsupported request target "http://evil.com/path/to/endpoint": only origin-form (starting with "/") is supported',
      );
    });
  });

  describe('createUndiciResponseToUWebSocketsResponseEmitter', () => {
    test('without body', async () => {
      const undiciResponse = new Response(null, {
        status: 201,
        statusText: 'Created',
        headers: [
          ['x-custom', 'some-value1'],
          ['x-custom', 'some-value2'],
          ['set-cookie', 'sessionId=abc123; Path=/; HttpOnly; Secure; SameSite=Lax'],
          ['set-cookie', 'ui_lang=en-US; Path=/; Max-Age=31536000; SameSite=Lax'],
        ],
      });

      const uWebSocketsResponse = mockUWebSocketsResponse({});

      const undiciResponseToUWebSocketsResponseEmitter = createUndiciResponseToUWebSocketsResponseEmitter();

      undiciResponseToUWebSocketsResponseEmitter(undiciResponse, uWebSocketsResponse);

      expect(uWebSocketsResponse.status).toBe('201 Created');
      expect(uWebSocketsResponse.headers).toMatchInlineSnapshot(`
        [
          [
            "x-custom",
            "some-value1, some-value2",
          ],
          [
            "set-cookie",
            "sessionId=abc123; Path=/; HttpOnly; Secure; SameSite=Lax",
          ],
          [
            "set-cookie",
            "ui_lang=en-US; Path=/; Max-Age=31536000; SameSite=Lax",
          ],
        ]
      `);

      expect(uWebSocketsResponse.ended).toBe(true);
    });

    test('with body', async () => {
      const undiciResponse = new Response(JSON.stringify({ name: 'test' }), {
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'json']],
      });

      const uWebSocketsResponse = mockUWebSocketsResponse({});

      const undiciResponseToUWebSocketsResponseEmitter = createUndiciResponseToUWebSocketsResponseEmitter();

      undiciResponseToUWebSocketsResponseEmitter(undiciResponse, uWebSocketsResponse);

      expect(uWebSocketsResponse.status).toBe('200 OK');
      expect(uWebSocketsResponse.headers).toMatchInlineSnapshot(`
        [
          [
            "content-type",
            "json",
          ],
        ]
      `);

      await wait(1);

      expect(uWebSocketsResponse.ended).toBe(true);
      expect(uWebSocketsResponse.chunks.join('')).toMatchInlineSnapshot('"{"name":"test"}"');
      expect(uWebSocketsResponse.closed).toBe(false);
    });

    test('with body, with backpressure', async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('chunk1'));
          controller.enqueue(new TextEncoder().encode('chunk2'));
          controller.close();
        },
      });

      const undiciResponse = new Response(body, {
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'text/plain']],
      });

      const uWebSocketsResponse = mockUWebSocketsResponse({ writeReturnValues: [false, true] });

      const undiciResponseToUWebSocketsResponseEmitter = createUndiciResponseToUWebSocketsResponseEmitter();

      undiciResponseToUWebSocketsResponseEmitter(undiciResponse, uWebSocketsResponse);

      await wait(10);

      // the first write signaled backpressure: the body stream is paused until the client is writable again
      expect(uWebSocketsResponse.chunks).toEqual(['chunk1']);
      expect(uWebSocketsResponse.ended).toBe(false);

      expect(uWebSocketsResponse.triggerWritable()).toBe(true);

      await wait(10);

      expect(uWebSocketsResponse.chunks).toEqual(['chunk1', 'chunk2']);
      expect(uWebSocketsResponse.ended).toBe(true);
    });

    test('with body containing an error', async () => {
      const undiciResponse = new Response(makeErroringWebStream(), {
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'json']],
      });

      const uWebSocketsResponse = mockUWebSocketsResponse({});

      const undiciResponseToUWebSocketsResponseEmitter = createUndiciResponseToUWebSocketsResponseEmitter();

      undiciResponseToUWebSocketsResponseEmitter(undiciResponse, uWebSocketsResponse);

      expect(uWebSocketsResponse.status).toBe('200 OK');
      expect(uWebSocketsResponse.headers).toMatchInlineSnapshot(`
        [
          [
            "content-type",
            "json",
          ],
        ]
      `);

      await wait(10);

      // an already started response cannot signal a failure: the connection gets closed
      // instead of ending the response as if it was complete
      expect(uWebSocketsResponse.chunks.join('')).toMatchInlineSnapshot('"hello"');
      expect(uWebSocketsResponse.ended).toBe(false);
      expect(uWebSocketsResponse.closed).toBe(true);
    });

    test('with body, with abort while sending the body', async () => {
      // oxlint-disable-next-line functional/no-let
      let cancelReason: unknown;

      const undiciResponse = new Response(
        makeStallingWebStream((reason) => {
          cancelReason = reason;
        }),
        {
          status: 200,
          statusText: 'OK',
          headers: [['content-type', 'text/plain']],
        },
      );

      const uWebSocketsResponse = mockUWebSocketsResponse({});

      const undiciResponseToUWebSocketsResponseEmitter = createUndiciResponseToUWebSocketsResponseEmitter();

      undiciResponseToUWebSocketsResponseEmitter(undiciResponse, uWebSocketsResponse);

      await wait(10);

      expect(uWebSocketsResponse.chunks.join('')).toBe('partial');

      uWebSocketsResponse.triggerAbort();

      await wait(10);

      // the client is gone: the streaming stopped without ending or closing the response
      // and the underlying web stream got cancelled
      expect(uWebSocketsResponse.ended).toBe(false);
      expect(uWebSocketsResponse.closed).toBe(false);
      expect((cancelReason as Error).message).toBe('Response has been aborted');
    });

    test('with body, with abort, with request factory sharing the same response', async () => {
      const uWebSocketsRequest = mockUWebSocketsRequest({
        method: 'get',
        url: '/path/to/endpoint',
        query: '',
        headers: [],
      });

      const uWebSocketsResponse = mockUWebSocketsResponse({});

      const uWebSocketsRequestToUndiciRequestFactory =
        createUWebSocketsRequestToUndiciRequestFactory('https://example.com');

      const serverRequest = uWebSocketsRequestToUndiciRequestFactory(uWebSocketsRequest, uWebSocketsResponse);

      const undiciResponse = new Response(makeStallingWebStream(), {
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'text/plain']],
      });

      const undiciResponseToUWebSocketsResponseEmitter = createUndiciResponseToUWebSocketsResponseEmitter();

      undiciResponseToUWebSocketsResponseEmitter(undiciResponse, uWebSocketsResponse);

      await wait(10);

      expect(uWebSocketsResponse.chunks.join('')).toBe('partial');

      uWebSocketsResponse.triggerAbort();

      await wait(10);

      // the single uWebSockets.js onAborted callback fans out to both the request factory
      // (abort signal) and the response emitter (stopped streaming)
      expect(serverRequest.signal.aborted).toBe(true);
      expect(uWebSocketsResponse.ended).toBe(false);
      expect(uWebSocketsResponse.closed).toBe(false);
    });
  });
});
