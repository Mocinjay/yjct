import type { WakeWordProvider } from './WakeWordProvider';

/**
 * Manual trigger for development: the Armed screen shows a "Trigger" button
 * wired to `fire()`. Lets the whole capture loop run with no Picovoice key.
 */
export class MockWakeWord implements WakeWordProvider {
  readonly name = 'mock';

  private onDetected: (() => void) | null = null;

  async start(onDetected: () => void): Promise<void> {
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
