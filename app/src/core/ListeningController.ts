import type { WakeMarker } from '../markers/markerMatching';
import type { WakeDetection, WakeWordProvider } from '../wakeword/WakeWordProvider';
import type { CaptureStatus } from './CaptureController';

/**
 * Glasses-only capture: nothing streams. The wearer records on the glasses
 * themselves, at full resolution, and this listens on the phone for
 * "Clypso". Each trigger becomes a marker, the wall-clock span of the moment,
 * which the full-resolution import cuts out of the recording once Meta AI has
 * synced it (services/glassesImport.ts).
 *
 * The same surface as CaptureController where the capture screen drives it:
 * arm/disarm/subscribe, and `captureNow` for the Clip button. A session's
 * marks count as its `sessionClipCount`, and `lastMarkAt` changes with each.
 */
export class ListeningController {
  private status: CaptureStatus = { state: 'idle', bufferedSeconds: 0, bufferedAsOf: Date.now() };
  private listeners = new Set<(s: CaptureStatus) => void>();
  private marks = 0;
  private armedSince: number | null = null;
  /** Bumped by every arm() and disarm(); see CaptureController.armGeneration. */
  private armGeneration = 0;

  constructor(
    private readonly wakeWord: WakeWordProvider,
    private readonly windowSeconds: number,
    private readonly recordMarker: (marker: WakeMarker) => Promise<void>,
  ) {}

  subscribe(listener: (s: CaptureStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  async arm(): Promise<void> {
    const generation = ++this.armGeneration;
    // A re-arm from 'error' continues the session, as in CaptureController.
    if (this.status.state !== 'error' && this.status.state !== 'arming') {
      this.marks = 0;
    }
    this.setStatus({ state: 'arming', bufferedSeconds: 0 });
    try {
      await this.wakeWord.start(detection => {
        this.mark(detection).catch(() => {});
      });
      if (generation !== this.armGeneration) {
        return;
      }
      this.armedSince = Date.now();
      this.setStatus({ state: 'armed', bufferedSeconds: 0 });
    } catch (err) {
      if (generation !== this.armGeneration) {
        return;
      }
      await this.disarm();
      this.setStatus({ state: 'error', bufferedSeconds: 0, lastError: errorMessage(err) });
      throw err;
    }
  }

  async disarm(): Promise<void> {
    this.armGeneration += 1;
    await this.wakeWord.stop().catch(() => {});
    this.armedSince = null;
    this.setStatus({ state: 'idle', bufferedSeconds: 0 });
  }

  /** Listening stopped on its own (the microphone could not be kept). */
  fail(message: string): void {
    if (this.armedSince !== null) {
      this.setStatus({ ...this.status, state: 'error', lastError: message });
    }
  }

  /** The Clip button: marks this moment. There is no clip to return yet. */
  async captureNow(): Promise<null> {
    if (this.status.state === 'armed') {
      await this.mark();
    }
    return null;
  }

  /** Extended recordings belong to the glasses here; nothing to start. */
  startClip(): void {}

  async stopClip(): Promise<null> {
    return null;
  }

  get lookBackSeconds(): number {
    return this.windowSeconds;
  }

  private async mark(detection?: WakeDetection): Promise<void> {
    // The provider stamps the phrase when it records its own audio; the
    // manual button marks the moment it is pressed.
    const atMs = Math.round(detection?.atMs ?? Date.now());
    const marker: WakeMarker = {
      id: `mark_${atMs}_${Math.random().toString(36).slice(2, 8)}`,
      atMs,
      startMs: atMs - this.windowSeconds * 1000,
    };
    try {
      await this.recordMarker(marker);
      this.marks += 1;
      this.setStatus({ ...this.status, lastError: undefined, lastMarkAt: atMs });
    } catch (err) {
      this.setStatus({ ...this.status, lastError: errorMessage(err) });
    }
  }

  private setStatus(
    status: Omit<CaptureStatus, 'bufferedAsOf' | 'armedSince' | 'sessionClipCount'>,
  ): void {
    this.status = {
      ...status,
      bufferedAsOf: Date.now(),
      armedSince: this.armedSince ?? undefined,
      sessionClipCount: this.marks,
    };
    this.listeners.forEach(l => l(this.status));
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
