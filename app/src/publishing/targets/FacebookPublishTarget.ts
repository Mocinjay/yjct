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
const GRAPH = 'https://graph-video.facebook.com/v23.0';
const GRAPH_READ = 'https://graph.facebook.com/v23.0';

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

  async authenticate(): Promise<void> {
    if (!(await this.isConfigured())) {
      throw new Error(
        'Facebook is not configured — add a Page id and Page access token ' +
          'in Settings → Connections (needs pages_manage_posts via the same ' +
          'Meta App Review as Instagram).',
      );
    }
  }

  async uploadAndPublish(
    clip: PublishableClip,
    caption: string,
    privacy: PublishPrivacy,
  ): Promise<{ publishId: string }> {
    if (!clip.hostedUrl) {
      throw new Error('Facebook publishing requires a hosted video URL.');
    }
    const form: Record<string, string> = {
      file_url: clip.hostedUrl,
      description: caption,
      title: clip.title,
      published: privacy === 'private' ? 'false' : 'true',
      access_token: this.auth.pageAccessToken!,
    };
    const res = await fetch(`${GRAPH}/${this.auth.pageId}/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    const json = await res.json();
    if (!res.ok || json.error) {
      throw new Error(`Facebook publish failed: ${json.error?.message ?? res.status}`);
    }
    return { publishId: json.id };
  }

  async checkStatus(publishId: string): Promise<PublishStatus> {
    try {
      const res = await fetch(
        `${GRAPH_READ}/${publishId}?fields=status,permalink_url&access_token=${this.auth.pageAccessToken}`,
      );
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(json.error?.message ?? `HTTP ${res.status}`);
      }
      const videoStatus = json.status?.video_status as string | undefined;
      return {
        state: videoStatus === 'ready' ? 'published' : 'processing',
        url: json.permalink_url
          ? `https://facebook.com${json.permalink_url}`
          : undefined,
      };
    } catch (err) {
      return {
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
