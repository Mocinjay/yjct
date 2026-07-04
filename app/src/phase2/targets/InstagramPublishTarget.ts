import type {
  PublishableClip,
  PublishPrivacy,
  PublishStatus,
  PublishTarget,
} from '../PublishTarget';

/**
 * Instagram Reels connector — Graph API container-based flow:
 *
 *   1. POST /{ig-user-id}/media   media_type=REELS + public video_url
 *   2. poll  /{container-id}?fields=status_code until FINISHED
 *   3. POST /{ig-user-id}/media_publish
 *
 * Requires: Business/Creator IG account linked to a Facebook Page, and a
 * token with instagram_content_publish — which needs Meta App Review
 * (bundle the Facebook permissions into the SAME review submission).
 *
 * A local file path is never sufficient here: the clip must be at a public
 * HTTPS URL (`requiresHostedUrl`).
 *
 * Note: IG Reels have no per-post privacy — visibility follows the account.
 */
const GRAPH = 'https://graph.facebook.com/v23.0';
const CONTAINER_POLL_MS = 3000;
const CONTAINER_TIMEOUT_MS = 5 * 60 * 1000;

export interface MetaGraphAuth {
  accessToken?: string;
  igUserId?: string;
}

export class InstagramPublishTarget implements PublishTarget {
  readonly platform = 'instagram' as const;
  readonly displayName = 'Instagram Reels';
  readonly requiresHostedUrl = true;

  constructor(private auth: MetaGraphAuth) {}

  async isConfigured(): Promise<boolean> {
    return Boolean(this.auth.accessToken && this.auth.igUserId);
  }

  async authenticate(): Promise<void> {
    if (!(await this.isConfigured())) {
      throw new Error(
        'Instagram is not configured — add a Graph API access token and IG ' +
          'user id in Settings → Connections (requires a Business/Creator ' +
          'account and Meta App Review for instagram_content_publish).',
      );
    }
  }

  async uploadAndPublish(
    clip: PublishableClip,
    caption: string,
    _privacy: PublishPrivacy,
  ): Promise<{ publishId: string }> {
    const { accessToken, igUserId } = this.auth;
    if (!clip.hostedUrl) {
      throw new Error('Instagram requires a hosted video URL.');
    }

    // 1. Create the media container.
    const container = await graphPost(`${GRAPH}/${igUserId}/media`, {
      media_type: 'REELS',
      video_url: clip.hostedUrl,
      caption,
      access_token: accessToken!,
    });

    // 2. Poll until Instagram has ingested the video.
    const deadline = Date.now() + CONTAINER_TIMEOUT_MS;
    for (;;) {
      const status = await graphGet(
        `${GRAPH}/${container.id}?fields=status_code&access_token=${accessToken}`,
      );
      if (status.status_code === 'FINISHED') {
        break;
      }
      if (status.status_code === 'ERROR') {
        throw new Error('Instagram could not process the video (container ERROR).');
      }
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for Instagram to process the video.');
      }
      await sleep(CONTAINER_POLL_MS);
    }

    // 3. Publish the container.
    const published = await graphPost(`${GRAPH}/${igUserId}/media_publish`, {
      creation_id: container.id,
      access_token: accessToken!,
    });
    return { publishId: published.id };
  }

  async checkStatus(publishId: string): Promise<PublishStatus> {
    try {
      const media = await graphGet(
        `${GRAPH}/${publishId}?fields=permalink&access_token=${this.auth.accessToken}`,
      );
      return {
        state: 'published',
        // Reels visibility follows the account (no per-post privacy).
        actualPrivacy: 'public',
        url: media.permalink as string | undefined,
      };
    } catch (err) {
      return {
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

async function graphPost(
  url: string,
  form: Record<string, string>,
): Promise<{ id: string }> {
  const body = new URLSearchParams(form).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`Graph API error: ${json.error?.message ?? res.status}`);
  }
  return json;
}

async function graphGet(url: string): Promise<Record<string, unknown> & { status_code?: string }> {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`Graph API error: ${json.error?.message ?? res.status}`);
  }
  return json;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
