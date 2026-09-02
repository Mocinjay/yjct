import { AppError, ErrorCode } from '../../core/errors';
import { readObject, readString, requireId } from '../../core/http';
import { GRAPH, GRAPH_VIDEO, graphGet, graphPost, graphUrl } from './metaGraph';
import type {
  PublishableClip,
  PublishPrivacy,
  PublishStatus,
  PublishTarget,
} from '../PublishTarget';

/**
 * Facebook Page video connector — same Meta app and the SAME App Review
 * submission as Instagram (bundle pages_manage_posts, pages_read_engagement,
 * pages_show_list with instagram_content_publish; do not file separately).
 *
 * Publishes via /{page-id}/videos with a hosted file_url.
 */
export interface FacebookPageAuth {
  pageId?: string;
  pageAccessToken?: string;
}

export class FacebookPublishTarget implements PublishTarget {
  readonly platform = 'facebook' as const;
  readonly displayName = 'Facebook';
  readonly requiresHostedUrl = true;

  constructor(private auth: FacebookPageAuth) {}

  async isConfigured(): Promise<boolean> {
    return Boolean(this.auth.pageId && this.auth.pageAccessToken);
  }

  private requireAuth(): { pageId: string; pageAccessToken: string } {
    const { pageId, pageAccessToken } = this.auth;
    if (!pageId || !pageAccessToken) {
      throw new AppError(
        ErrorCode.PublishNotConfigured,
        'Facebook is not configured — add a Page id and Page access token ' +
          'in Settings → Connections (needs pages_manage_posts via the same ' +
          'Meta App Review as Instagram).',
      );
    }
    return { pageId, pageAccessToken };
  }

  async authenticate(): Promise<void> {
    this.requireAuth();
  }

  async uploadAndPublish(
    clip: PublishableClip,
    caption: string,
    privacy: PublishPrivacy,
  ): Promise<{ publishId: string }> {
    const { pageId, pageAccessToken } = this.requireAuth();
    if (!clip.hostedUrl) {
      throw new AppError(
        ErrorCode.PublishUploadFailed,
        'Facebook publishing requires a hosted video URL.',
      );
    }
    const body = await graphPost(
      graphUrl(GRAPH_VIDEO, pageId, 'videos'),
      pageAccessToken,
      {
        file_url: clip.hostedUrl,
        description: caption,
        title: clip.title,
        published: privacy === 'private' ? 'false' : 'true',
      },
      'Facebook publish',
    );
    return { publishId: requireId(body, 'id', 'Facebook publish') };
  }

  async checkStatus(publishId: string): Promise<PublishStatus> {
    try {
      const { pageAccessToken } = this.requireAuth();
      // Reads go to the plain Graph host: graph-video only serves uploads.
      const body = await graphGet(
        graphUrl(GRAPH, publishId),
        pageAccessToken,
        ['status', 'permalink_url'],
        'Facebook status',
      );
      const videoStatus = readString(readObject(body, 'status'), 'video_status');
      const permalink = readString(body, 'permalink_url');
      return {
        state: videoStatus === 'ready' ? 'published' : 'processing',
        url: permalink ? `https://facebook.com${permalink}` : undefined,
      };
    } catch (err) {
      return {
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
