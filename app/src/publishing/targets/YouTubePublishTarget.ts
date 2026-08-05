import RNFS from 'react-native-fs';
import type {
  PublishableClip,
  PublishPrivacy,
  PublishStatus,
  PublishTarget,
} from '../PublishTarget';

/**
 * YouTube Shorts connector — first of the four per the build order
 * (lightest review process). Direct file upload via the YouTube Data API v3
 * resumable protocol; no cloud hosting required.
 *
 * OAuth is injected: this module never owns Google credentials. Wire a
 * token provider once the Google Cloud project + OAuth client exist
 * (react-native-app-auth or Google Sign-In both fit). Until then
 * `isConfigured()` is false and the UI shows "needs setup".
 *
 * ⚠️ Ship gate: the OAuth client must pass Google's API verification for
 * the youtube.upload scope before real users can use this.
 */
export interface GoogleTokenProvider {
  /** Resolves a valid OAuth2 access token with youtube.upload scope. */
  getAccessToken(): Promise<string>;
  /** Interactive sign-in. */
  signIn(): Promise<void>;
  isSignedIn(): Promise<boolean>;
}

const UPLOAD_ENDPOINT =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';
const VIDEOS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';

export class YouTubePublishTarget implements PublishTarget {
  readonly platform = 'youtube' as const;
  readonly displayName = 'YouTube Shorts';
  readonly requiresHostedUrl = false;

  constructor(private tokens: GoogleTokenProvider | null) {}

  async isConfigured(): Promise<boolean> {
    return this.tokens !== null;
  }

  async authenticate(): Promise<void> {
    if (!this.tokens) {
      throw new Error(
        'YouTube is not configured yet — a Google OAuth client (with the ' +
          'youtube.upload scope) has to be created and wired to a token provider.',
      );
    }
    if (!(await this.tokens.isSignedIn())) {
      await this.tokens.signIn();
    }
  }

  async uploadAndPublish(
    clip: PublishableClip,
    caption: string,
    privacy: PublishPrivacy,
  ): Promise<{ publishId: string }> {
    if (!this.tokens) {
      throw new Error('YouTube target not configured.');
    }
    const token = await this.tokens.getAccessToken();
    const stat = await RNFS.stat(clip.localFilePath);

    // 1. Open a resumable upload session with the metadata.
    const init = await fetch(UPLOAD_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(stat.size),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify({
        snippet: {
          title: clip.title,
          // #Shorts in title/description opts the upload into Shorts for
          // eligible vertical video.
          description: `${caption}\n#Shorts`,
        },
        status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
      }),
    });
    if (!init.ok) {
      throw new Error(`YouTube upload init failed: ${init.status} ${await init.text()}`);
    }
    const location = init.headers.get('location');
    if (!location) {
      throw new Error('YouTube did not return a resumable upload URL.');
    }

    // 2. Stream the file bytes to the session URL.
    const upload = await RNFS.uploadFiles({
      toUrl: location,
      files: [
        {
          name: 'video',
          filename: clip.localFilePath.split('/').pop() ?? 'clip.mp4',
          filepath: clip.localFilePath,
          filetype: 'video/mp4',
        },
      ],
      method: 'PUT',
      binaryStreamOnly: true,
      headers: { 'Content-Type': 'video/mp4' },
    }).promise;
    if (upload.statusCode !== 200 && upload.statusCode !== 201) {
      throw new Error(`YouTube upload failed: HTTP ${upload.statusCode}`);
    }
    const video = JSON.parse(upload.body) as { id: string };
    return { publishId: video.id };
  }

  async checkStatus(publishId: string): Promise<PublishStatus> {
    if (!this.tokens) {
      return { state: 'failed', error: 'YouTube target not configured.' };
    }
    const token = await this.tokens.getAccessToken();
    const res = await fetch(
      `${VIDEOS_ENDPOINT}?part=status,processingDetails&id=${publishId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      return { state: 'failed', error: `Status check failed: ${res.status}` };
    }
    const data = (await res.json()) as {
      items?: Array<{
        status?: { privacyStatus?: string; uploadStatus?: string };
        processingDetails?: { processingStatus?: string };
      }>;
    };
    const item = data.items?.[0];
    if (!item) {
      return { state: 'failed', error: 'Video not found.' };
    }
    const processing = item.processingDetails?.processingStatus;
    return {
      state: processing === 'processing' ? 'processing' : 'published',
      actualPrivacy: (item.status?.privacyStatus as PublishStatus['actualPrivacy']) ?? undefined,
      url: `https://youtube.com/shorts/${publishId}`,
    };
  }
}
