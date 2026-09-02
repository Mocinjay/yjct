import RNFS from 'react-native-fs';
import { AppError, ErrorCode } from '../../core/errors';
import {
  httpJson,
  httpRequest,
  parseJsonObject,
  readObject,
  readString,
  requireId,
  requireHttpsRedirectTarget,
} from '../../core/http';
import type {
  PublishableClip,
  PublishPrivacy,
  PublishStatus,
  PublishTarget,
} from '../PublishTarget';
import { publishFailure } from '../PublishTarget';

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

  private requireTokens(): GoogleTokenProvider {
    if (!this.tokens) {
      throw new AppError(
        ErrorCode.PublishNotConfigured,
        'YouTube is not configured yet — a Google OAuth client (with the ' +
          'youtube.upload scope) has to be created and wired to a token provider.',
      );
    }
    return this.tokens;
  }

  async authenticate(): Promise<void> {
    const tokens = this.requireTokens();
    if (!(await tokens.isSignedIn())) {
      await tokens.signIn();
    }
  }

  async uploadAndPublish(
    clip: PublishableClip,
    caption: string,
    privacy: PublishPrivacy,
  ): Promise<{ publishId: string }> {
    const token = await this.requireTokens().getAccessToken();
    const stat = await RNFS.stat(clip.localFilePath);

    // 1. Open a resumable upload session with the metadata.
    const init = await httpRequest(UPLOAD_ENDPOINT, {
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
      label: 'YouTube upload init',
    });
    if (!init.ok) {
      const detail = await init.text().catch(() => '');
      throw new AppError(
        init.status === 401 || init.status === 403
          ? ErrorCode.PublishAuthFailed
          : ErrorCode.PublishUploadFailed,
        `YouTube upload init failed: ${init.status} ${detail}`,
      );
    }
    const location = init.headers.get('location');
    if (!location) {
      throw new AppError(
        ErrorCode.PublishUploadFailed,
        'YouTube did not return a resumable upload URL.',
      );
    }

    // 2. Stream the file bytes to the session URL. The destination came off the
    //    wire, so it is checked before the clip is sent to it.
    const upload = await RNFS.uploadFiles({
      toUrl: requireHttpsRedirectTarget(location, 'YouTube resumable upload URL'),
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
      throw new AppError(
        ErrorCode.PublishUploadFailed,
        `YouTube upload failed: HTTP ${upload.statusCode}`,
      );
    }
    // Was a bare `JSON.parse`, which threw a SyntaxError naming a character
    // offset if YouTube answered with anything else.
    return {
      publishId: requireId(parseJsonObject(upload.body), 'id', 'YouTube upload'),
    };
  }

  async checkStatus(publishId: string): Promise<PublishStatus> {
    try {
      const token = await this.requireTokens().getAccessToken();
      const { ok, status, body } = await httpJson(
        `${VIDEOS_ENDPOINT}?part=status,processingDetails&id=${encodeURIComponent(publishId)}`,
        { headers: { Authorization: `Bearer ${token}` }, label: 'YouTube status' },
      );
      if (!ok) {
        return { state: 'failed', error: `Status check failed: ${status}` };
      }
      const items = Array.isArray(body.items) ? body.items : [];
      const item = items[0];
      if (!item || typeof item !== 'object') {
        return { state: 'failed', error: 'Video not found.' };
      }
      const record = item as Record<string, unknown>;
      const processing = readString(
        readObject(record, 'processingDetails'),
        'processingStatus',
      );
      return {
        state: processing === 'processing' ? 'processing' : 'published',
        actualPrivacy: readString(
          readObject(record, 'status'),
          'privacyStatus',
        ) as PublishStatus['actualPrivacy'],
        url: `https://youtube.com/shorts/${publishId}`,
      };
    } catch (err) {
      return publishFailure(err);
    }
  }
}
