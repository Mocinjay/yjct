import type {
  PublishableClip,
  PublishPrivacy,
  PublishStatus,
  PublishTarget,
} from '../PublishTarget';

/**
 * Dev connector: exercises the whole publish pipeline (hosting → upload →
 * status polling) with no credentials. Deliberately mimics the TikTok
 * audit behavior — the requested privacy is IGNORED and the "platform"
 * forces private — so the UI's honest-visibility handling gets tested from
 * day one.
 */
export class MockPublishTarget implements PublishTarget {
  readonly platform = 'mock' as const;
  readonly displayName = 'Mock platform (dev)';
  readonly requiresHostedUrl = true;

  private jobs = new Map<string, { startedAt: number; requested: PublishPrivacy }>();

  async isConfigured(): Promise<boolean> {
    return true;
  }

  async authenticate(): Promise<void> {
    await sleep(300);
  }

  async uploadAndPublish(
    clip: PublishableClip,
    _caption: string,
    privacy: PublishPrivacy,
  ): Promise<{ publishId: string }> {
    if (!clip.hostedUrl) {
      throw new Error('MockPublishTarget requires a hosted URL (like IG/TikTok).');
    }
    await sleep(1200);
    const publishId = `mock_${Date.now()}`;
    this.jobs.set(publishId, { startedAt: Date.now(), requested: privacy });
    return { publishId };
  }

  async checkStatus(publishId: string): Promise<PublishStatus> {
    const job = this.jobs.get(publishId);
    if (!job) {
      return { state: 'failed', error: 'Unknown publish id.' };
    }
    if (Date.now() - job.startedAt < 3000) {
      return { state: 'processing' };
    }
    return {
      state: 'published',
      // Audit-mode behavior: requested privacy is not honored.
      actualPrivacy: 'private',
      url: `https://mock.fadeaway.invalid/${publishId}`,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
