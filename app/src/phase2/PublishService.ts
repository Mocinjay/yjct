import { hasBurnedCaptions } from '../core/ClipStore';
import type { Clip } from '../types';
import { captionQueue } from './CaptionQueue';
import type { ClipHosting } from './ClipHosting';
import { MockClipHosting } from './ClipHosting';
import { connectorConfigStore } from './ConnectorConfig';
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
  /** Publish the captioned cut, captioning the clip first if it has none. */
  withCaptions: boolean;
}

/**
 * Phase 2 composition root. Targets and hosting are rebuilt from the stored
 * connector config on every call, so pasting sandbox credentials in
 * Settings → Connections lights a connector up immediately.
 */
export class PublishService {
  // The mock target keeps state (fake job ids), so it outlives listTargets().
  private mockTarget = new MockPublishTarget();

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
      // Dev only: it is always "configured", and a publish to it marks the
      // clip as published (kept forever) with a fake URL.
      ...(__DEV__ ? [this.mockTarget] : []),
    ];
  }

  async publish(
    clip: Clip,
    target: PublishTarget,
    options: PublishOptions,
  ): Promise<{ publishId: string }> {
    await target.authenticate();
    // Resolved before captioning, so a missing hosting config fails at once
    // rather than after a full caption render.
    const hosting = target.requiresHostedUrl ? await hostingFor(target) : null;

    let filePath = clip.filePath;
    if (options.withCaptions) {
      // hasBurnedCaptions implies captionedFilePath is set. Anything else,
      // a mock copy included, is resolved by the queue.
      filePath = hasBurnedCaptions(clip)
        ? clip.captionedFilePath!
        : await captionedCut(clip.id);
    }

    const hostedUrl = hosting
      ? (await hosting.upload(filePath)).hostedUrl
      : undefined;

    return target.uploadAndPublish(
      {
        localFilePath: filePath,
        hostedUrl,
        title: clip.name,
      },
      options.caption,
      options.privacy,
    );
  }

  checkStatus(target: PublishTarget, publishId: string): Promise<PublishStatus> {
    return target.checkStatus(publishId);
  }
}

/**
 * Captions through CaptionQueue rather than calling a captioner directly. The
 * queue may already be rendering this clip into the same output file, it
 * holds renders while the glasses record, and the cut it produces is recorded
 * on the clip: reused next time and deleted with the clip, never orphaned.
 * A clip the queue has already finished (a mock copy, say) comes back as is.
 */
async function captionedCut(clipId: string): Promise<string> {
  const clip = await captionQueue.captionNow(clipId);
  if (!clip) {
    throw new Error('The clip was deleted before captioning finished.');
  }
  if (clip.captionState !== 'ready' || !clip.captionedFilePath) {
    throw new Error(clip.captionError ?? 'Captioning did not finish.');
  }
  return clip.captionedFilePath;
}

/**
 * Where a platform that pulls from a URL gets the clip. The presign endpoint
 * when one is set; otherwise only the dev mock platform can publish, with
 * fake hosting. A real platform handed the fake `.invalid` URL would fail
 * late, with a platform error that says nothing about hosting.
 */
async function hostingFor(target: PublishTarget): Promise<ClipHosting> {
  const { hostingPresignUrl } = await connectorConfigStore.get();
  if (hostingPresignUrl) {
    return new PresignedUrlClipHosting(hostingPresignUrl);
  }
  if (target.platform === 'mock') {
    return new MockClipHosting();
  }
  throw new Error(
    `${target.displayName} needs the clip at a public URL — add a clip ` +
      'hosting presign endpoint in Settings → Connections.',
  );
}

export const publishService = new PublishService();
