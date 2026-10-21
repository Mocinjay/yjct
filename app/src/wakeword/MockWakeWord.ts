import type { WakeDetection, WakeWordProvider } from './WakeWordProvider';

/**
 * Manual trigger, chosen in Settings as "Manual button". The Armed screen's
 * Clip button calls `fire()` instead of saving directly, so the whole capture
 * loop runs without speech recognition. Detections carry no word timing, so
 * the clip ends at the buffer boundary.
 */
export class MockWakeWord implements WakeWordProvider {
  private onDetected: ((detection?: WakeDetection) => void) | null = null;

  async start(onDetected: (detection?: WakeDetection) => void): Promise<void> {
    this.onDetected = onDetected;
  }

  async stop(): Promise<void> {
    this.onDetected = null;
  }

  /** Simulate a wake-word detection. */
  fire(): void {
    this.onDetected?.();
  }
}
