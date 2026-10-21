import { ListeningController } from '../src/core/ListeningController';
import type { CaptureStatus } from '../src/core/CaptureController';
import type { WakeMarker } from '../src/markers/markerMatching';
import type { WakeDetection, WakeWordProvider } from '../src/wakeword/WakeWordProvider';

class FakeWakeWord implements WakeWordProvider {
  private cb: ((detection?: WakeDetection) => void) | null = null;
  startError: Error | null = null;
  async start(onDetected: (detection?: WakeDetection) => void) {
    if (this.startError) {
      throw this.startError;
    }
    this.cb = onDetected;
  }
  async stop() {
    this.cb = null;
  }
  fire(detection?: WakeDetection) {
    this.cb?.(detection);
  }
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function setup(sink?: (m: WakeMarker) => Promise<void>) {
  const wake = new FakeWakeWord();
  const markers: WakeMarker[] = [];
  const controller = new ListeningController(
    wake,
    30,
    sink ??
      (async m => {
        markers.push(m);
      }),
  );
  let last: CaptureStatus | null = null;
  controller.subscribe(s => {
    last = s;
  });
  return { wake, markers, controller, status: () => last! };
}

describe('ListeningController', () => {
  it('marks the spoken moment with the window before it', async () => {
    const { wake, markers, controller, status } = setup();
    await controller.arm();
    expect(status().state).toBe('armed');

    wake.fire({ segmentPath: '/wake-1.m4a', endOffsetSec: 2, atMs: 1_000_000 });
    await settle();

    expect(markers).toEqual([
      { id: expect.stringMatching(/^mark_1000000_/), atMs: 1_000_000, startMs: 970_000 },
    ]);
    expect(status()).toMatchObject({ sessionClipCount: 1, lastMarkAt: 1_000_000 });
  });

  it('marks the moment the manual button is pressed', async () => {
    const { markers, controller } = setup();
    await controller.arm();
    const before = Date.now();
    await controller.captureNow();
    expect(markers).toHaveLength(1);
    expect(markers[0].atMs).toBeGreaterThanOrEqual(before);
  });

  it('reports a microphone that would not open', async () => {
    const { wake, controller, status } = setup();
    wake.startError = new Error('Microphone access is off');
    await expect(controller.arm()).rejects.toThrow('Microphone access is off');
    expect(status()).toMatchObject({ state: 'error', lastError: 'Microphone access is off' });
    expect(status().armedSince).toBeUndefined();
  });

  it('shows a marker that could not be saved instead of counting it', async () => {
    const { controller, status } = setup(async () => {
      throw new Error('storage full');
    });
    await controller.arm();
    await controller.captureNow();
    expect(status()).toMatchObject({ sessionClipCount: 0, lastError: 'storage full' });
  });

  it('goes to error when listening stops on its own, and a re-arm keeps the count', async () => {
    const { controller, status } = setup();
    await controller.arm();
    await controller.captureNow();
    controller.fail('Listening stopped and could not be restarted.');
    expect(status().state).toBe('error');

    await controller.arm();
    expect(status()).toMatchObject({ state: 'armed', sessionClipCount: 1 });
  });
});
