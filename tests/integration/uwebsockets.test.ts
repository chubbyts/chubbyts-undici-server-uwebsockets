import fetch from 'cross-fetch';
import { expect, test } from 'vitest';

test('get', async () => {
  const response = await fetch(`${process.env.HTTP_URI}/path/to/get/route`);

  expect(response.status).toBe(200);
  expect(response.statusText).toBe('OK');
  expect(response.headers.get('content-type')).toBe('application/json');

  expect(await response.json()).toMatchInlineSnapshot(`
    {
      "body": "",
      "headers": {
        "accept": "*/*",
        "accept-encoding": "gzip,deflate",
        "connection": "keep-alive",
        "user-agent": "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
      },
      "method": "GET",
      "url": "https://example.com/path/to/get/route",
    }
  `);
});

test('post', async () => {
  const response = await fetch(`${process.env.HTTP_URI}/path/to/post/route`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: 'test' }),
  });

  expect(response.status).toBe(200);
  expect(response.statusText).toBe('OK');
  expect(response.headers.get('content-type')).toBe('application/json');

  expect(await response.json()).toMatchInlineSnapshot(`
    {
      "body": "{"message":"test"}",
      "headers": {
        "accept": "*/*",
        "accept-encoding": "gzip,deflate",
        "connection": "keep-alive",
        "content-length": "18",
        "content-type": "application/json",
        "user-agent": "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
      },
      "method": "POST",
      "url": "https://example.com/path/to/post/route",
    }
  `);
});
