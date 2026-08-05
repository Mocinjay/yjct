/**
 * PHASE 2 — connector contract. Each platform (YouTube Shorts, Instagram,
 * Facebook, TikTok) is one isolated module behind this interface,
 * swappable/mockable so nothing needs live credentials to test.
 *
 * Free-tier sharing does NOT go through this — that's the native OS share
 * sheet.
 *
 * Platform invariants the implementations must respect:
 *  - Instagram/TikTok require a CDN-hosted HTTPS URL (`requiresHostedUrl`);
 *    a local file path is never sufficient for them. YouTube accepts a
 *    direct file upload.
 *  - TikTok: never post without a per-clip preview + explicit user consent
 *    step; until their manual audit clears, every post is forced private —
 *    `PublishStatus.actualPrivacy` must surface ACTUAL visibility to the
 *    UI, never the visibility the user requested.
 */
export type PublishPrivacy = 'public' | 'private' | 'unlisted';

export interface PublishableClip {
  /** Local MP4 path (used by direct-upload targets like YouTube). */
  localFilePath: string;
  /** CDN-fronted HTTPS URL (required by Instagram/TikTok-style targets). */
  hostedUrl?: string;
  title: string;
  durationSec: number;
}

export interface PublishStatus {
  state: 'pending' | 'processing' | 'published' | 'failed';
  /** Actual visibility on the platform, which may differ from requested. */
  actualPrivacy?: PublishPrivacy;
  url?: string;
  error?: string;
}

export interface PublishTarget {
  readonly platform: 'youtube' | 'instagram' | 'facebook' | 'tiktok' | 'mock';
  readonly displayName: string;
  /** True → clip must be uploaded to cloud hosting before publishing. */
  readonly requiresHostedUrl: boolean;

  /** True when this target has credentials and is ready to publish. */
  isConfigured(): Promise<boolean>;

  authenticate(): Promise<void>;

  uploadAndPublish(
    clip: PublishableClip,
    caption: string,
    privacy: PublishPrivacy,
  ): Promise<{ publishId: string }>;

  checkStatus(publishId: string): Promise<PublishStatus>;
}
