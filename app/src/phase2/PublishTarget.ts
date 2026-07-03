/**
 * PHASE 2 SEAM — interface only. No connector code ships in Phase 1.
 *
 * Each platform (YouTube Shorts, Instagram, Facebook, TikTok) becomes one
 * isolated module behind this contract, swappable/mockable so nothing needs
 * live credentials to test. Free-tier sharing does NOT go through this —
 * that's the native OS share sheet.
 *
 * TikTok-specific invariants for the eventual implementation:
 *  - never post without a per-clip preview + explicit user consent step;
 *  - until their manual audit clears, every post is forced private — the
 *    returned PublishStatus must surface ACTUAL visibility to the UI, never
 *    the visibility the user requested.
 */
export type PublishPrivacy = 'public' | 'private' | 'followers';

export interface PublishStatus {
  state: 'pending' | 'processing' | 'published' | 'failed';
  /** Actual visibility on the platform, which may differ from requested. */
  actualPrivacy?: PublishPrivacy;
  url?: string;
  error?: string;
}

export interface PublishTarget {
  readonly platform: 'youtube' | 'instagram' | 'facebook' | 'tiktok';

  authenticate(): Promise<void>;

  /**
   * Uploads and publishes a clip. `clipUrl` is a CDN-fronted HTTPS URL —
   * Instagram and TikTok require hosted media; a local file path is never
   * sufficient here.
   */
  uploadAndPublish(
    clipUrl: string,
    caption: string,
    privacy: PublishPrivacy,
  ): Promise<{ publishId: string }>;

  checkStatus(publishId: string): Promise<PublishStatus>;
}
