import { settingsStore } from '../core/SettingsStore';
import { captionEngineUsable } from '../native/CaptionEngineNative';
import { OnDeviceCaptioningProvider } from './OnDeviceCaptioningProvider';
import type { Clip } from '../types';
import type { CaptioningProvider } from './CaptioningProvider';
import type { ClipHosting } from './ClipHosting';
import { MockClipHosting } from './ClipHosting';
import { connectorConfigStore } from './ConnectorConfig';
import { HttpCaptioningProvider } from './HttpCaptioningProvider';
import { MockCaptioningProvider } from './MockCaptioningProvider';
import { PresignedUrlClipHosting } from './PresignedUrlClipHosting';
import type {
  PublishPrivacy,
  PublishStatus,
  PublishTarget,
} from './PublishTarget';
import { FacebookPublishTarget } from './targets/FacebookPublishTarget';
import { InstagramPublishTarget } from './targets/InstagramPublishTarget';
import { MockPublishTarget } from './targets/MockPublishTarget';
import { TikTokPublishTarget } from './targets/TikTokPublishTarget';
import { YouTubePublishTarget } from './targets/YouTubePublishTarget';

export interface PublishOptions {
  caption: string;
  privacy: PublishPrivacy;
  /** Run the (Pro) captioning step before publishing. */
  withCaptions: boolean;
}

/**
 * Phase 2 composition root. Targets and hosting are rebuilt from the stored
 * connector config on every listTargets() call, so pasting sandbox
 * credentials in Settings → Connections lights a connector up immediately.
 *
 * Swap the mock captioner for the real external infra here and nowhere else.
 */
export class PublishService {
  // The mock target keeps state (fake job ids), so it persists across builds.
  private mockTarget = new MockPublishTarget();

  /**
   * Captioning runs on the phone when it can. Order matters:
   *
   *  1. on-device (iOS) — no server, no key, audio never leaves the device
   *  2. the self-hosted HTTP service — Android, or iOS where on-device
   *     recognition is unavailable for the locale
   *  3. the mock — dev only, and it labels itself as such
   */
  async getCaptioner(): Promise<CaptioningProvider> {
    if (await captionEngineUsable()) {
      const { climaxEdit } = await settingsStore.get();
      return new OnDeviceCaptioningProvider(climaxEdit);
    }
    const cfg = await connectorConfigStore.get();
    return cfg.captioningUrl
      ? new HttpCaptioningProvider(cfg.captioningUrl)
      : new MockCaptioningProvider();
  }

  async listTargets(): Promise<PublishTarget[]> {
    const cfg = await connectorConfigStore.get();
    return [
      // Google OAuth client not created yet → token provider stays null.
      new YouTubePublishTarget(null),
      new InstagramPublishTarget({
        accessToken: cfg.meta?.accessToken,
        igUserId: cfg.meta?.igUserId,
      }),
      new FacebookPublishTarget({
        pageId: cfg.meta?.pageId,
        pageAccessToken: cfg.meta?.pageAccessToken,
      }),
      new TikTokPublishTarget({
        accessToken: cfg.tiktok?.accessToken,
        auditCleared: cfg.tiktok?.auditCleared,
      }),
      this.mockTarget,
    ];
  }

  async getHosting(): Promise<ClipHosting> {
    const cfg = await connectorConfigStore.get();
    return cfg.hostingPresignUrl
      ? new PresignedUrlClipHosting(cfg.hostingPresignUrl)
      : new MockClipHosting();
  }

  async publish(
    clip: Clip,
    target: PublishTarget,
    options: PublishOptions,
  ): Promise<{ publishId: string }> {
    await target.authenticate();

    let filePath = clip.filePath;
    if (options.withCaptions) {
      if (clip.captionState === 'ready' && clip.captionedFilePath) {
        // Auto-captioning already burned this clip. Re-running would
        // re-transcribe and re-encode it for an identical result.
        filePath = clip.captionedFilePath;
      } else {
        const { captionStyle } = await settingsStore.get();
        const captioner = await this.getCaptioner();
        const captioned = await captioner.caption(filePath, {
          style: captionStyle,
        });
        filePath = captioned.captionedFilePath;
      }
    }

    let hostedUrl: string | undefined;
    if (target.requiresHostedUrl) {
      const hosting = await this.getHosting();
      hostedUrl = (await hosting.upload(filePath)).hostedUrl;
    }

    return target.uploadAndPublish(
      {
        localFilePath: filePath,
        hostedUrl,
        title: clip.name,
        durationSec: clip.durationSec,
      },
      options.caption,
      options.privacy,
    );
  }

  checkStatus(target: PublishTarget, publishId: string): Promise<PublishStatus> {
    return target.checkStatus(publishId);
  }
}

export const publishService = new PublishService();
