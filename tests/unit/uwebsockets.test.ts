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
  headers: Record<string, string>;
}) => {
  return {
    getMethod: () => method,
    getUrl: () => url,
    getQuery: () => query,
    forEach: (callback) => {
      Object.entries(headers).forEach(([name, value]) => callback(name, value));
    },
  } as HttpRequest;
};

const mockUWebSocketsResponse = ({ body = undefined, abort = false }: { body?: string; abort?: boolean }) => {
  return {
    onData: (callback) => {
      if (undefined === body) {
        throw new Error('no body');
      }

      const bodyLength = body.length;

      // eslint-disable-next-line functional/no-let
      let start = 0;
      // eslint-disable-next-line functional/no-let
      let end;
      // eslint-disable-next-line functional/no-let
      let isLast = false;

      while (true) {
        end = start + Math.ceil(Math.random() * (bodyLength - start));

        isLast = end === bodyLength;

        callback(new TextEncoder().encode(body.substring(start, end)).buffer, isLast);

        if (isLast) {
          return;
        }

        start = end;
      }
    },
    onAborted: (callback) => {
      if (abort) {
        callback();
      }
    },
  } as HttpResponse;
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
  });

  describe('createUWebSocketsRequestToUndiciRequestFactory', () => {
    test('get', async () => {
      const uWebSocketsRequest = mockUWebSocketsRequest({
        method: 'get',
        url: '/path/to/endpoint',
        query: 'key=value',
        headers: {
          Accept: 'application/json',
        },
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

    test('post', async () => {
      const uWebSocketsRequest = mockUWebSocketsRequest({
        method: 'post',
        url: '/path/to/endpoint',
        query: 'key=value',
        headers: {
          'content-type': 'multipart/form-data; boundary=WebKitFormBoundary7MA4YWxkTrZu0gW',
          Accept: 'application/json',
        },
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

      // eslint-disable-next-line functional/no-let
      let status;

      // eslint-disable-next-line functional/no-let, prefer-const
      let headers: Array<[string, string]> = [];

      // eslint-disable-next-line functional/no-let
      let end = false;

      const uWebSocketsResponse = {
        cork: (callback) => {
          callback();
        },
        end: () => {
          end = true;
        },
        writeStatus: (_status: string) => {
          status = _status;
        },
        writeHeader: (key: string, value: string) => {
          // eslint-disable-next-line functional/immutable-data
          headers.push([key, value]);
        },
      } as HttpResponse;

      const undiciResponseToUWebSocketsResponseEmitter = createUndiciResponseToUWebSocketsResponseEmitter();

      undiciResponseToUWebSocketsResponseEmitter(undiciResponse, uWebSocketsResponse);

      expect(status).toBe('201 Created');
      expect(headers).toMatchInlineSnapshot(`
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

      expect(end).toBe(true);
    });

    test('with body', async () => {
      const undiciResponse = new Response(JSON.stringify({ name: 'test' }), {
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'json']],
      });

      // eslint-disable-next-line functional/no-let
      let status;

      // eslint-disable-next-line functional/no-let, prefer-const
      let headers: Array<[string, string]> = [];

      // eslint-disable-next-line functional/no-let
      let end = false;

      // eslint-disable-next-line functional/no-let
      let body = '';

      const uWebSocketsResponse = {
        cork: (callback) => {
          callback();
        },
        end: () => {
          end = true;
        },
        writeStatus: (_status: string) => {
          status = _status;
        },
        writeHeader: (key: string, value: string) => {
          // eslint-disable-next-line functional/immutable-data
          headers.push([key, value]);
        },
        write: (content) => {
          body += content;
        },
      } as HttpResponse;

      const undiciResponseToUWebSocketsResponseEmitter = createUndiciResponseToUWebSocketsResponseEmitter();

      undiciResponseToUWebSocketsResponseEmitter(undiciResponse, uWebSocketsResponse);

      expect(status).toBe('200 OK');
      expect(headers).toMatchInlineSnapshot(`
        [
          [
            "content-type",
            "json",
          ],
        ]
      `);

      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 1);
      });

      expect(end).toBe(true);
      expect(body).toMatchInlineSnapshot('"{"name":"test"}"');
    });

    test('with body containing an error', async () => {
      const makeErroringWebStream = (): ReadableStream<Uint8Array> => {
        // eslint-disable-next-line functional/no-let
        let sent = false;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('hello'));
            setTimeout(() => {
              if (!sent) {
                sent = true;
                controller.error(new Error('boom'));
              }
            }, 1);
          },
        });
      };

      const undiciResponse = new Response(makeErroringWebStream(), {
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'json']],
      });

      // eslint-disable-next-line functional/no-let
      let status;

      // eslint-disable-next-line functional/no-let, prefer-const
      let headers: Array<[string, string]> = [];

      // eslint-disable-next-line functional/no-let
      let end = false;

      // eslint-disable-next-line functional/no-let
      let body = '';

      const uWebSocketsResponse = {
        cork: (callback) => {
          callback();
        },
        end: () => {
          end = true;
        },
        writeStatus: (_status: string) => {
          status = _status;
        },
        writeHeader: (key: string, value: string) => {
          // eslint-disable-next-line functional/immutable-data
          headers.push([key, value]);
        },
        write: (content) => {
          body += content;
        },
      } as HttpResponse;

      const undiciResponseToUWebSocketsResponseEmitter = createUndiciResponseToUWebSocketsResponseEmitter();

      undiciResponseToUWebSocketsResponseEmitter(undiciResponse, uWebSocketsResponse);

      expect(status).toBe('200 OK');
      expect(headers).toMatchInlineSnapshot(`
        [
          [
            "content-type",
            "json",
          ],
        ]
      `);

      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 2);
      });

      expect(end).toBe(true);
      expect(body).toMatchInlineSnapshot('"hello"');
    });
  });
});
