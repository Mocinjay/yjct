import { ErrorCode, isAppError } from '../src/core/errors';
import {
  httpJson,
  parseJsonObject,
  readObject,
  readString,
  redactUrl,
  requireHttpsUrl,
  requireId,
} from '../src/core/http';

describe('parseJsonObject', () => {
  it('returns the object for well-formed JSON', () => {
    expect(parseJsonObject('{"id":"abc"}')).toEqual({ id: 'abc' });
  });

  it.each([
    ['an HTML error page', '<html>502 Bad Gateway</html>'],
    ['an empty body', ''],
    ['a bare array', '[1,2,3]'],
    ['a bare scalar', '"hello"'],
    ['null', 'null'],
  ])('returns {} for %s', (_label, body) => {
    // Every caller indexes the result by key, so anything that is not an object
    // is as unusable as unparsed text — and must not throw here, because the
    // caller is about to report the HTTP status, which is the better error.
    expect(parseJsonObject(body)).toEqual({});
  });
});

describe('readString / readObject', () => {
  it('rejects non-string and empty values', () => {
    const body = { a: 'x', b: 42, c: '', d: null };
    expect(readString(body, 'a')).toBe('x');
    expect(readString(body, 'b')).toBeUndefined();
    expect(readString(body, 'c')).toBeUndefined();
    expect(readString(body, 'missing')).toBeUndefined();
  });

  it('returns {} rather than an array or null', () => {
    expect(readObject({ a: { x: 1 } }, 'a')).toEqual({ x: 1 });
    expect(readObject({ a: [1] }, 'a')).toEqual({});
    expect(readObject({ a: null }, 'a')).toEqual({});
  });
});

describe('requireId', () => {
  it('returns the id when present', () => {
    expect(requireId({ publish_id: 'p1' }, 'publish_id', 'TikTok')).toBe('p1');
  });

  it('throws a tracking-failure rather than a TypeError when absent', () => {
    // The connectors used to end on `json.data.publish_id`, so a shape change
    // surfaced as a TypeError thrown after the post had already been accepted.
    try {
      requireId({}, 'publish_id', 'TikTok');
      throw new Error('should have thrown');
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      expect(isAppError(err) && err.code).toBe(ErrorCode.PublishStatusUnknown);
    }
  });
});

describe('requireHttpsUrl', () => {
  it('accepts https', () => {
    expect(requireHttpsUrl('https://x.test/p', ErrorCode.HostingNotConfigured, 'u')).toBe(
      'https://x.test/p',
    );
  });

  it.each(['http://localhost:8000', 'http://127.0.0.1:8000', 'http://10.0.2.2:8000'])(
    'accepts %s so the Python services can be developed against',
    url => {
      expect(requireHttpsUrl(url, ErrorCode.HostingNotConfigured, 'u')).toBe(url);
    },
  );

  it.each([
    'http://example.com/upload',
    'file:///etc/passwd',
    'ftp://example.com',
    'not a url',
    '',
  ])('rejects %s', url => {
    expect(() => requireHttpsUrl(url, ErrorCode.HostingNotConfigured, 'u')).toThrow();
  });

  it('does not treat userinfo as the host', () => {
    // `http://localhost@evil.test/` has host evil.test, not localhost — reading
    // the authority left-to-right would have waved this through.
    expect(() =>
      requireHttpsUrl('http://localhost@evil.test/', ErrorCode.HostingNotConfigured, 'u'),
    ).toThrow();
  });
});

describe('redactUrl', () => {
  it('drops the query, where access tokens used to live', () => {
    expect(redactUrl('https://graph.facebook.com/v23.0/me?access_token=SECRET')).toBe(
      'https://graph.facebook.com/v23.0/me',
    );
  });
});

describe('httpJson', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.useRealTimers();
  });

  it('surfaces a timeout as a typed network failure instead of hanging', async () => {
    // fetch has no default timeout, so a black-holed network sat on the publish
    // spinner indefinitely with no error and no way out.
    globalThis.fetch = jest.fn(
      (_url, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('Aborted')),
          );
        }),
    ) as unknown as typeof fetch;

    const promise = httpJson('https://x.test/slow', { timeoutMs: 10, label: 'Probe' });
    await expect(promise).rejects.toMatchObject({
      code: ErrorCode.PublishNetworkFailed,
    });
  });

  it('returns the parsed error body on a non-2xx rather than discarding it', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"Invalid parameter","code":100}}',
    })) as unknown as typeof fetch;

    const { ok, status, body } = await httpJson('https://x.test/p');
    expect(ok).toBe(false);
    expect(status).toBe(400);
    // The actionable part of a Graph failure is in the body, not the status.
    expect(readString(readObject(body, 'error'), 'message')).toBe('Invalid parameter');
  });

  it('does not throw when the error body is not JSON', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => '<html>Bad Gateway</html>',
    })) as unknown as typeof fetch;

    await expect(httpJson('https://x.test/p')).resolves.toMatchObject({
      status: 502,
      body: {},
    });
  });
});
