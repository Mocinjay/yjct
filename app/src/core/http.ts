import { AppError, ErrorCode, describe } from './errors';

/**
 * The one place network calls are made.
 *
 * Every connector had hand-rolled its own `fetch` + `res.json()` pair, and all
 * of them shared the same three holes:
 *
 * 1. **No timeout.** `fetch` has none by default, and RN's default is the
 *    platform's, which is minutes. A publish against a black-holed network sat
 *    on a spinner with no way out and no error — the single worst failure shape
 *    for a screen the wearer is waiting on.
 * 2. **Unguarded `res.json()`.** A gateway that answers with an HTML error page
 *    threw a `SyntaxError` mentioning `<`, which is what the user then saw.
 *    Worse, `json.data.publish_id` on a shape-shifted response threw a
 *    `TypeError` from inside the success path.
 * 3. **Untyped failures.** Bare `Error`s carrying raw platform text, so nothing
 *    upstream could tell "your token expired" from "the wifi is down".
 */

/** Ceiling on any single request. Uploads do not go through here. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpJsonOptions extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  /** Code for a transport failure or timeout. */
  networkCode?: ErrorCode;
  /** Names the caller in developer-facing messages, e.g. 'Instagram'. */
  label?: string;
}

/**
 * A JSON request that always resolves to an object or throws an `AppError`.
 *
 * The non-2xx branch still parses the body before giving up: every API here
 * puts the useful part of a failure (`error.message`, `error.code`) in the
 * body, so discarding it on status alone throws away the only actionable
 * detail. Callers get the parsed body either way and decide what counts as a
 * failure — TikTok signals errors with HTTP 200 and `error.code !== 'ok'`.
 */
export async function httpJson(
  url: string,
  options: HttpJsonOptions = {},
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await httpRequest(url, options);
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, body: parseJsonObject(text) };
}

/**
 * The raw response, for the two callers that need a header off it.
 *
 * YouTube's resumable protocol answers the init POST with an empty body and
 * puts the session URL in `Location`, so `httpJson` is the wrong shape there —
 * but the timeout and the typed transport failure are still wanted.
 */
export async function httpRequest(
  url: string,
  options: HttpJsonOptions = {},
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    networkCode = ErrorCode.PublishNetworkFailed,
    label = 'Request',
    ...init
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // An abort and a dropped connection arrive the same way, but only one of
    // them is worth telling the user to check their signal over.
    const timedOut = controller.signal.aborted;
    throw new AppError(
      networkCode,
      timedOut
        ? `${label} timed out after ${timeoutMs}ms`
        : `${label} could not reach the network: ${describe(err)}`,
      { cause: err, context: { url: redactUrl(url), timedOut } },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A JSON object, or an empty one.
 *
 * Returning `{}` rather than throwing is deliberate: the caller is about to
 * check the status and the platform's own error field anyway, and a body that
 * did not parse is a *worse* thing to report than the HTTP status it came with.
 * Arrays and bare scalars are treated as unparsed for the same reason — every
 * caller indexes the result by key.
 */
export function parseJsonObject(text: string): Record<string, unknown> {
  if (!text) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Reads a string field, or undefined when the server sent something else. */
export function readString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads a nested object field, or an empty object. */
export function readObject(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = body[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The id a create/publish call was supposed to return.
 *
 * Every connector ended its happy path on `json.data.publish_id` or `json.id`
 * with no check, so a response that had changed shape — or an error the status
 * check missed — surfaced as a `TypeError` from inside the success branch,
 * after the upload had already happened. Failing here says which call lied.
 */
export function requireId(
  body: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const id = readString(body, key);
  if (!id) {
    throw new AppError(
      ErrorCode.PublishStatusUnknown,
      `${label} returned no ${key}, so the post cannot be tracked`,
      { context: { keys: Object.keys(body) } },
    );
  }
  return id;
}

/**
 * A URL the user typed, validated before anything is sent to it.
 *
 * Both the presign endpoint and the captioning service are pasted into
 * Settings, and both receive a clip. `http://` there would put the wearer's
 * footage on the wire in the clear, and a typo'd scheme (`file:`, `data:`)
 * would have been handed straight to `fetch`. Localhost over http is allowed
 * because that is how the Python services are developed against.
 */
export function requireHttpsUrl(
  raw: string,
  code: ErrorCode,
  label: string,
): string {
  const parsed = parseUrl(raw);
  if (!parsed) {
    throw new AppError(code, `${label} is not a valid http(s) URL: ${raw}`);
  }
  if (parsed.scheme === 'https' || (parsed.scheme === 'http' && isLoopback(parsed.host))) {
    return raw.trim();
  }
  throw new AppError(code, `${label} must be an https:// URL (got ${parsed.scheme}://)`, {
    userMessage:
      'That address must start with https:// — clips are not sent over an ' +
      'unencrypted connection.',
  });
}

/**
 * Scheme + host, by regex.
 *
 * Not `new URL()`: React Native's `URL` is a near-stub that keeps the string
 * and exposes almost none of the WHATWG getters, so `parsed.protocol` reads
 * back `undefined` on device while passing under Jest's Node `URL`. A check
 * that silently succeeds on the one platform it was meant to guard is worse
 * than no check, so the two fields actually needed are read directly.
 */
function parseUrl(raw: string): { scheme: string; host: string } | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(raw.trim());
  if (!match) {
    return null;
  }
  // Strips any userinfo and port, leaving the host to compare.
  const authority = match[2];
  const host = authority.slice(authority.lastIndexOf('@') + 1).split(':')[0];
  return { scheme: match[1].toLowerCase(), host: host.toLowerCase() };
}

/** 10.0.2.2 is how the Android emulator reaches the host machine. */
function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '10.0.2.2';
}

/**
 * A URL a *server* handed back and we are about to upload to.
 *
 * Presign endpoints return the destination, so a compromised or misconfigured
 * one could redirect the clip anywhere. Same rule as a typed URL; the check is
 * cheap and the thing being protected is the footage itself.
 */
export function requireHttpsRedirectTarget(raw: string, label: string): string {
  return requireHttpsUrl(raw, ErrorCode.HostingUploadFailed, label);
}

/**
 * Scheme, host and path only.
 *
 * The query string is where access tokens used to live, and a log line is
 * exactly the place a token outlives the request that carried it.
 */
export function redactUrl(raw: string): string {
  const withoutQuery = raw.split(/[?#]/)[0];
  const parsed = parseUrl(withoutQuery);
  if (!parsed) {
    return '<unparseable url>';
  }
  const path = withoutQuery.slice(withoutQuery.indexOf(parsed.host) + parsed.host.length);
  return `${parsed.scheme}://${parsed.host}${path}`;
}
