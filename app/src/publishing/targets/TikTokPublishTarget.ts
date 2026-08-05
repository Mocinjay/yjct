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

  async authenticate(): Promise<void> {
    if (!(await this.isConfigured())) {
      throw new Error(
        'TikTok is not configured — add a Content Posting API access token ' +
          'in Settings → Connections (sandbox token until the audit clears).',
      );
    }
  }

  async uploadAndPublish(
    clip: PublishableClip,
    caption: string,
    privacy: PublishPrivacy,
  ): Promise<{ publishId: string }> {
    if (!clip.hostedUrl) {
      throw new Error('TikTok requires a hosted video URL (PULL_FROM_URL).');
    }
    const res = await fetch(`${API}/video/init/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.auth.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
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
      }),
    });
    const json = await res.json();
    if (!res.ok || json.error?.code !== 'ok') {
      throw new Error(`TikTok publish failed: ${json.error?.message ?? res.status}`);
    }
    return { publishId: json.data.publish_id };
  }

  async checkStatus(publishId: string): Promise<PublishStatus> {
    try {
      const res = await fetch(`${API}/status/fetch/`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.auth.accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({ publish_id: publishId }),
      });
      const json = await res.json();
      if (!res.ok || json.error?.code !== 'ok') {
        throw new Error(json.error?.message ?? `HTTP ${res.status}`);
      }
      const status = json.data?.status as string | undefined;
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
        error: status === 'FAILED' ? (json.data?.fail_reason as string) : undefined,
      };
    } catch (err) {
      return {
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
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
