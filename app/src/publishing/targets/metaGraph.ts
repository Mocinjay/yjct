import { AppError, ErrorCode } from '../../core/errors';
import { httpJson, readObject, readString } from '../../core/http';

/**
 * The Meta Graph calls shared by the Instagram and Facebook connectors.
 *
 * They are one app, one App Review submission and one error format, so they
 * were already duplicating this pair of functions verbatim — including the
 * duplicated mistake below.
 *
 * **The token moves to a header.** Both connectors put `access_token=` in the
 * query string, which Meta accepts but which writes a long-lived Page token
 * into every proxy log, crash report and `console` line the URL touches. Graph
 * honours `Authorization: Bearer`, so there is no reason to keep it in the URL.
 */

export const GRAPH = 'https://graph.facebook.com/v23.0';
export const GRAPH_VIDEO = 'https://graph-video.facebook.com/v23.0';

/**
 * Builds `base/{id}/edge` with the id escaped.
 *
 * The ids are user-supplied (pasted into Settings) and were interpolated raw,
 * so a value containing `/` or `?` silently retargeted the request at a
 * different endpoint.
 */
export function graphUrl(base: string, ...segments: string[]): string {
  return [base, ...segments.map(encodeURIComponent)].join('/');
}

export async function graphPost(
  url: string,
  accessToken: string,
  form: Record<string, string>,
  label: string,
): Promise<Record<string, unknown>> {
  const { ok, status, body } = await httpJson(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
    label,
  });
  throwIfGraphError(ok, status, body, label);
  return body;
}

export async function graphGet(
  url: string,
  accessToken: string,
  fields: string[],
  label: string,
): Promise<Record<string, unknown>> {
  const query = fields.length ? `?fields=${encodeURIComponent(fields.join(','))}` : '';
  const { ok, status, body } = await httpJson(`${url}${query}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    label,
  });
  throwIfGraphError(ok, status, body, label);
  return body;
}

/**
 * Graph reports failures in the body, and does so even on some 200s, so status
 * alone is not the signal. The `code`/`type` pair is what distinguishes an
 * expired token — which the wearer can fix — from a rejected clip, which they
 * cannot.
 */
function throwIfGraphError(
  ok: boolean,
  status: number,
  body: Record<string, unknown>,
  label: string,
): void {
  const error = readObject(body, 'error');
  if (ok && Object.keys(error).length === 0) {
    return;
  }
  const message = readString(error, 'message') ?? `HTTP ${status}`;
  const type = readString(error, 'type');
  const subcode = error.error_subcode;
  // 190 is the whole OAuth family (expired, revoked, wrong app); 10 and 200–299
  // are permission failures, which for this app means App Review has not
  // granted the scope yet. Both are "reconnect", not "retry".
  const code = typeof error.code === 'number' ? error.code : status;
  const isAuth =
    code === 190 ||
    code === 10 ||
    (code >= 200 && code <= 299) ||
    status === 401 ||
    status === 403;
  throw new AppError(
    isAuth ? ErrorCode.PublishAuthFailed : ErrorCode.PublishRejected,
    `${label}: ${message}`,
    { context: { code, type, subcode, status } },
  );
}
