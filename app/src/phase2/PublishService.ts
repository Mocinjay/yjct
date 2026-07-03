import type { Clip } from '../types';
import type { CaptioningProvider } from './CaptioningProvider';
import type { ClipHosting } from './ClipHosting';
import { MockClipHosting } from './ClipHosting';
import { MockCaptioningProvider } from './MockCaptioningProvider';
import type {
  PublishPrivacy,
  PublishStatus,
  PublishTarget,
} from './PublishTarget';
import { MockPublishTarget } from './targets/MockPublishTarget';
import { YouTubePublishTarget } from './targets/YouTubePublishTarget';

export interface PublishOptions {
  caption: string;
  privacy: PublishPrivacy;
  /** Run the (Pro) captioning step before publishing. */
  withCaptions: boolean;
}

/**
 * Phase 2 composition root: owns the configured hosting, captioning, and
 * connector instances and runs the pipeline
 *
 *   clip → [caption] → [host if target requires it] → uploadAndPublish
 *
 * Swap the mocks for real infra here and nowhere else.
 */
export class PublishService {
  private captioner: CaptioningProvider = new MockCaptioningProvider();
  private hosting: ClipHosting = new MockClipHosting();
  private targets: PublishTarget[] = [
    // Google OAuth client not created yet → token provider is null and the
    // target reports unconfigured. First connector to wire per build order.
    new YouTubePublishTarget(null),
    new MockPublishTarget(),
  ];

  listTargets(): PublishTarget[] {
    return this.targets;
  }

  getTarget(platform: string): PublishTarget | undefined {
    return this.targets.find(t => t.platform === platform);
  }

  async publish(
    clip: Clip,
    target: PublishTarget,
    options: PublishOptions,
  ): Promise<{ publishId: string }> {
    await target.authenticate();

    let filePath = clip.filePath;
    if (options.withCaptions) {
      const captioned = await this.captioner.caption(filePath);
      filePath = captioned.captionedFilePath;
    }

    let hostedUrl: string | undefined;
    if (target.requiresHostedUrl) {
      hostedUrl = (await this.hosting.upload(filePath)).hostedUrl;
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
