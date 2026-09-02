import { AppError, ErrorCode } from '../../core/errors';
import { httpJson, readObject, readString, requireId } from '../../core/http';
import type {
  PublishableClip,
  PublishPrivacy,
  PublishStatus,
  PublishTarget,
} from '../PublishTarget';

/**
 * TikTok connector — Content Posting API, Direct Post via PULL_FROM_URL.
 *
 * Hard rules from the project spec, enforced here and in the publish UI:
 *  - There is NO code path that posts without the per-clip preview +
 *    explicit consent step (the UI confirm dialog gates every publish).
 *  - Until TikTok's manual audit clears (`auditCleared` flag, set only on
 *    written confirmation), every post is forced private/self-only by the
 *    platform REGARDLESS of requested privacy — `checkStatus` reports the
 *    forced visibility, never the requested one.
 *  - Sandbox only until the audit; no unofficial endpoints, ever.
 */
const API = 'https://open.tiktokapis.com/v2/post/publish';

export interface TikTokAuth {
  accessToken?: string;
  auditCleared?: boolean;
}

export class TikTokPublishTarget implements PublishTarget {
  readonly platform = 'tiktok' as const;
  readonly displayName = 'TikTok';
  readonly requiresHostedUrl = true;

  constructor(private auth: TikTokAuth) {}

  async isConfigured(): Promise<boolean> {
    return Boolean(this.auth.accessToken);
  }

  private requireToken(): string {
    const { accessToken } = this.auth;
    if (!accessToken) {
      throw new AppError(
        ErrorCode.PublishNotConfigured,
        'TikTok is not configured — add a Content Posting API access token ' +
          'in Settings → Connections (sandbox token until the audit clears).',
      );
    }
    return accessToken;
  }

  async authenticate(): Promise<void> {
    this.requireToken();
  }

  async uploadAndPublish(
    clip: PublishableClip,
    caption: string,
    privacy: PublishPrivacy,
  ): Promise<{ publishId: string }> {
    const accessToken = this.requireToken();
    if (!clip.hostedUrl) {
      throw new AppError(
        ErrorCode.PublishUploadFailed,
        'TikTok requires a hosted video URL (PULL_FROM_URL).',
      );
    }
    const body = await tiktokPost(
      `${API}/video/init/`,
      accessToken,
      {
        post_info: {
          title: caption || clip.title,
          privacy_level: toTikTokPrivacy(privacy),
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: {
          source: 'PULL_FROM_URL',
          video_url: clip.hostedUrl,
        },
      },
      'TikTok publish',
    );
    // Was `json.data.publish_id` — a shape TikTok is under no obligation to
    // keep, and a TypeError thrown here would have been thrown *after* the post
    // was already accepted.
    return {
      publishId: requireId(readObject(body, 'data'), 'publish_id', 'TikTok publish'),
    };
  }

  async checkStatus(publishId: string): Promise<PublishStatus> {
    try {
      const accessToken = this.requireToken();
      const body = await tiktokPost(
        `${API}/status/fetch/`,
        accessToken,
        { publish_id: publishId },
        'TikTok status',
      );
      const data = readObject(body, 'data');
      const status = readString(data, 'status');
      const state: PublishStatus['state'] =
        status === 'PUBLISH_COMPLETE'
          ? 'published'
          : status === 'FAILED'
            ? 'failed'
            : 'processing';
      return {
        state,
        // Pre-audit, TikTok forces self-only visibility no matter what was
        // requested. Never report otherwise until auditCleared is set.
        actualPrivacy: this.auth.auditCleared ? undefined : 'private',
        error: status === 'FAILED' ? readString(data, 'fail_reason') : undefined,
      };
    } catch (err) {
      return {
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * TikTok answers 200 with `error.code === 'ok'` on success, so the HTTP status
 * is only half the check — a rejected post and an accepted one are the same
 * status line.
 */
async function tiktokPost(
  url: string,
  accessToken: string,
  payload: unknown,
  label: string,
): Promise<Record<string, unknown>> {
  const { ok, status, body } = await httpJson(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(payload),
    label,
  });
  const error = readObject(body, 'error');
  const code = readString(error, 'code');
  if (ok && code === 'ok') {
    return body;
  }
  const isAuth =
    status === 401 ||
    status === 403 ||
    code === 'access_token_invalid' ||
    code === 'scope_not_authorized';
  throw new AppError(
    isAuth ? ErrorCode.PublishAuthFailed : ErrorCode.PublishRejected,
    `${label}: ${readString(error, 'message') ?? code ?? `HTTP ${status}`}`,
    { context: { code, status, logId: readString(error, 'log_id') } },
  );
}

function toTikTokPrivacy(privacy: PublishPrivacy): string {
  switch (privacy) {
    case 'public':
      return 'PUBLIC_TO_EVERYONE';
    case 'unlisted':
      return 'FOLLOWER_OF_CREATOR';
    case 'private':
      return 'SELF_ONLY';
  }
}
