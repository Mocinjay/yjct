import RNFS from 'react-native-fs';
import { clipStore } from '../core/ClipStore';
import { entitlementStore } from '../core/EntitlementStore';
import { settingsStore } from '../core/SettingsStore';
import type { Clip } from '../types';
import { publishService } from './PublishService';

/**
 * Runs every new clip through captioning as soon as it is captured, so the
 * library shows a finished, captioned clip instead of asking the wearer to
 * push a button per clip.
 *
 * Progress lives on the clip in the index, not in memory. Two reasons: the
 * library can render "Captioning…" from the same data it already reads, and a
 * job interrupted by the app being killed is still visibly unfinished on the
 * next launch — `resume()` picks those back up rather than leaving a clip
 * stuck mid-pipeline forever.
 *
 * One job at a time on purpose. Captioning is transcription plus a re-encode
 * on the other end; firing a whole armed session's clips at it in parallel
 * just makes every one of them slower.
 */
export class CaptionQueue {
  private pending: string[] = [];
  private active: string | null = null;
  private draining = false;
  /**
   * Clips spoken for — queued or running. Held separately from `pending`
   * because claiming has to happen synchronously: `push()` awaits before it
   * can enqueue, and two callers racing on the same clip would otherwise both
   * get past the check while the other was mid-await.
   */
  private claimed = new Set<string>();

  /**
   * Queue a freshly captured clip. No-op for free tier — captioning is Pro,
   * and a spinner that resolves to a paywall is worse than no spinner.
   */
  async enqueue(clipId: string): Promise<void> {
    if (!(await entitlementStore.isPro())) {
      return;
    }
    await this.push(clipId);
  }

  /** Re-run captioning for one clip, whatever state it is in. */
  async retry(clipId: string): Promise<void> {
    if (!(await entitlementStore.isPro())) {
      return;
    }
    await this.push(clipId, { force: true });
  }

  /**
   * Re-arms jobs that were interrupted by the app being killed. Called at
   * launch: anything still marked queued/processing has no worker behind it.
   */
  async resume(): Promise<void> {
    const clips = await clipStore.list();
    const stranded = clips.filter(
      c => c.captionState === 'queued' || c.captionState === 'processing',
    );
    if (stranded.length === 0) {
      return;
    }
    if (!(await entitlementStore.isPro())) {
      // Pro lapsed mid-job. Clear the state instead of showing progress that
      // is never going to move.
      for (const clip of stranded) {
        await clipStore.setCaptionState(clip.id, {
          captionState: 'none',
          captionError: null,
        });
      }
      return;
    }
    for (const clip of stranded) {
      await this.push(clip.id, { force: true });
    }
  }

  /** Clips waiting or running — for tests and diagnostics. */
  get depth(): number {
    return this.claimed.size;
  }

  private async push(clipId: string, options?: { force: boolean }): Promise<void> {
    if (this.claimed.has(clipId)) {
      return;
    }
    this.claimed.add(clipId);
    let queued = false;
    try {
      const clip = (await clipStore.list()).find(c => c.id === clipId);
      if (!clip) {
        return;
      }
      if (!options?.force && clip.captionState === 'ready') {
        return;
      }
      await clipStore.setCaptionState(clipId, {
        captionState: 'queued',
        captionError: null,
      });
      this.pending.push(clipId);
      queued = true;
    } finally {
      if (!queued) {
        this.claimed.delete(clipId);
      }
    }
    this.drain();
  }

  private drain(): void {
    if (this.draining) {
      return;
    }
    this.draining = true;
    void (async () => {
      try {
        let next = this.pending.shift();
        while (next !== undefined) {
          this.active = next;
          try {
            await this.run(next);
          } finally {
            this.claimed.delete(next);
            this.active = null;
          }
          next = this.pending.shift();
        }
      } finally {
        this.active = null;
        this.draining = false;
      }
    })();
  }

  private async run(clipId: string): Promise<void> {
    const clip = (await clipStore.list()).find(c => c.id === clipId);
    if (!clip) {
      // Deleted or swept while it sat in the queue.
      return;
    }
    const style = (await settingsStore.get()).captionStyle;
    try {
      await clipStore.setCaptionState(clipId, { captionState: 'processing' });
      const captioner = await publishService.getCaptioner();
      const { captionedFilePath } = await captioner.caption(clip.filePath, {
        style,
      });
      if (!(await clipStore.list()).some(c => c.id === clipId)) {
        // Deleted or swept while this was encoding. setCaptionState would
        // ignore the write anyway; the burn-in would just be left on disk
        // with nothing referencing it.
        await RNFS.unlink(captionedFilePath).catch(() => {});
        return;
      }
      await discardPrevious(clip, captionedFilePath);
      await clipStore.setCaptionState(clipId, {
        captionState: 'ready',
        captionedFilePath,
        captionStyle: style,
        captionProvider: captioner.name,
        captionError: null,
      });
    } catch (err) {
      await clipStore
        .setCaptionState(clipId, {
          captionState: 'failed',
          captionError: err instanceof Error ? err.message : String(err),
        })
        .catch(() => {});
    }
  }
}

/** A re-caption in a different style leaves the old burn-in behind. */
async function discardPrevious(clip: Clip, nextPath: string): Promise<void> {
  if (clip.captionedFilePath && clip.captionedFilePath !== nextPath) {
    await RNFS.unlink(clip.captionedFilePath).catch(() => {});
  }
}

export const captionQueue = new CaptionQueue();
