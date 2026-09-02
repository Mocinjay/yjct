import { AppError, ErrorCode } from '../../core/errors';
import { GRAPH, graphGet, graphPost, graphUrl } from './metaGraph';
import { readString, requireId } from '../../core/http';
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

  /**
   * Narrows the optional credentials to present ones.
   *
   * `isConfigured()` returning true told the compiler nothing, so every call
   * site below re-asserted with `!` — which is exactly the assertion that would
   * have been wrong if the two checks ever drifted apart.
   */
  private requireAuth(): { accessToken: string; igUserId: string } {
    const { accessToken, igUserId } = this.auth;
    if (!accessToken || !igUserId) {
      throw new AppError(
        ErrorCode.PublishNotConfigured,
        'Instagram is not configured — add a Graph API access token and IG ' +
          'user id in Settings → Connections (requires a Business/Creator ' +
          'account and Meta App Review for instagram_content_publish).',
      );
    }
    return { accessToken, igUserId };
  }

  async authenticate(): Promise<void> {
    this.requireAuth();
  }

  async uploadAndPublish(
    clip: PublishableClip,
    caption: string,
    _privacy: PublishPrivacy,
  ): Promise<{ publishId: string }> {
    const { accessToken, igUserId } = this.requireAuth();
    if (!clip.hostedUrl) {
      throw new AppError(
        ErrorCode.PublishUploadFailed,
        'Instagram requires a hosted video URL.',
      );
    }

    // 1. Create the media container.
    const container = await graphPost(
      graphUrl(GRAPH, igUserId, 'media'),
      accessToken,
      { media_type: 'REELS', video_url: clip.hostedUrl, caption },
      'Instagram container',
    );
    const containerId = requireId(container, 'id', 'Instagram container');

    // 2. Poll until Instagram has ingested the video.
    const deadline = Date.now() + CONTAINER_TIMEOUT_MS;
    for (;;) {
      const status = await graphGet(
        graphUrl(GRAPH, containerId),
        accessToken,
        ['status_code'],
        'Instagram container status',
      );
      const code = readString(status, 'status_code');
      if (code === 'FINISHED') {
        break;
      }
      if (code === 'ERROR') {
        throw new AppError(
          ErrorCode.PublishRejected,
          'Instagram could not process the video (container ERROR).',
        );
      }
      if (Date.now() > deadline) {
        throw new AppError(
          ErrorCode.PublishStatusUnknown,
          'Timed out waiting for Instagram to process the video.',
        );
      }
      await sleep(CONTAINER_POLL_MS);
    }

    // 3. Publish the container.
    const published = await graphPost(
      graphUrl(GRAPH, igUserId, 'media_publish'),
      accessToken,
      { creation_id: containerId },
      'Instagram publish',
    );
    return { publishId: requireId(published, 'id', 'Instagram publish') };
  }

  async checkStatus(publishId: string): Promise<PublishStatus> {
    try {
      const { accessToken } = this.requireAuth();
      const media = await graphGet(
        graphUrl(GRAPH, publishId),
        accessToken,
        ['permalink'],
        'Instagram status',
      );
      return {
        state: 'published',
        // Reels visibility follows the account (no per-post privacy).
        actualPrivacy: 'public',
        url: readString(media, 'permalink'),
      };
    } catch (err) {
      return {
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
