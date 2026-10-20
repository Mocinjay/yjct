import RNFS from 'react-native-fs';
import { clipStore } from '../core/ClipStore';
import { entitlementStore } from '../core/EntitlementStore';
import { settingsStore } from '../core/SettingsStore';
import type { Clip } from '../types';
import { getCaptioner } from './captioner';

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
 * One job at a time on purpose. Captioning is a transcription plus a full
 * re-encode; running a whole armed session's clips in parallel just makes
 * every one of them slower.
 *
 * Nothing starts while the glasses are recording (`setCaptureActive`). A
 * caption burn is a full-clip export on the same media hardware the live
 * capture and the wake-word transcription use, and running it mid-session is
 * what cost captured footage frames. Clips queue up and caption once the
 * wearer disarms. A job already running when capture starts finishes.
 *
 * Every caption render goes through this queue, publishing included
 * (`captionNow`): all providers write `<clip>.captioned.<style>.mp4`, so a
 * second render of the same clip outside the queue would delete or overwrite
 * the file this one records.
 */
export class CaptionQueue {
  private pending: string[] = [];
  private draining = false;
  /**
   * Clips spoken for — queued or running. Held separately from `pending`
   * because claiming has to happen synchronously: `push()` awaits before it
   * can enqueue, and two callers racing on the same clip would otherwise both
   * get past the check while the other was mid-await.
   */
  private claimed = new Set<string>();
  private captureActive = false;
  /**
   * `captionNow()` callers waiting on a clip, keyed by clip id. Resolved
   * whenever that clip's claim is released: its job finished, or a `push()`
   * declined it.
   */
  private waiters = new Map<string, Array<() => void>>();

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
   * Captions one clip for a caller that needs the result now (publishing),
   * and resolves with the clip as stored once its job has ended. The caller
   * checks `captionState` on the result; undefined means the clip is gone.
   *
   * - A clip already queued or running is joined, not rendered twice.
   * - A clip that is already 'ready' comes back as it is.
   * - The clip moves to the front of the queue: after a disarm the queue can
   *   hold a whole session's clips, and the publish should not wait for all
   *   of them.
   * - It refuses while capture is live rather than waiting. The hold can last
   *   as long as an extended recording, and a publish spinner must not hang
   *   on it. (A capture that starts after the clip is queued holds it like
   *   any other job.)
   */
  async captionNow(clipId: string): Promise<Clip | undefined> {
    if (this.captureActive) {
      throw new Error(
        'Captions are paused while the glasses are recording. Stop recording ' +
          'to publish with captions, or turn captions off.',
      );
    }
    const finished = new Promise<void>(resolve => {
      this.waiters.set(clipId, [...(this.waiters.get(clipId) ?? []), resolve]);
    });
    // Not forced: a clip that finished since the caller last looked is used,
    // not re-rendered.
    await this.push(clipId);
    const at = this.pending.indexOf(clipId);
    if (at > 0) {
      this.pending.splice(at, 1);
      this.pending.unshift(clipId);
    }
    await finished;
    return (await clipStore.list()).find(c => c.id === clipId);
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

  /**
   * Holds new jobs while a capture session is live and releases them when it
   * ends. Driven by the capture session's status (services/capture.ts).
   */
  setCaptureActive(active: boolean): void {
    if (this.captureActive === active) {
      return;
    }
    this.captureActive = active;
    if (!active) {
      this.drain();
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
        // A captionNow() that joined this claim while it was being decided
        // has no job coming to resolve it.
        this.settle(clipId);
      }
    }
    this.drain();
  }

  private drain(): void {
    if (this.draining || this.captureActive) {
      return;
    }
    this.draining = true;
    void (async () => {
      try {
        // Re-checked per job: capture can start while one is running, and the
        // rest then wait for it to end.
        while (!this.captureActive) {
          const next = this.pending.shift();
          if (next === undefined) {
            break;
          }
          try {
            await this.run(next);
          } finally {
            this.claimed.delete(next);
            this.settle(next);
          }
        }
      } finally {
        this.draining = false;
      }
    })();
  }

  /** Wakes every captionNow() waiting on this clip. */
  private settle(clipId: string): void {
    const waiting = this.waiters.get(clipId);
    if (waiting) {
      this.waiters.delete(clipId);
      waiting.forEach(resolve => resolve());
    }
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
      const captioner = await getCaptioner();
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
