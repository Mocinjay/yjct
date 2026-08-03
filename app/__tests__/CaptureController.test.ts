import type { DeviceVideoSource } from '../src/device/DeviceVideoSource';
import type { Segment } from '../src/types';
import type {
  WakeDetection,
  WakeWordProvider,
} from '../src/wakeword/WakeWordProvider';

const mockFiles = new Map<string, string>();

// CaptureController reads the Pro entitlement to decide whether a new clip
// gets a retention clock, which pulls AsyncStorage into this suite.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (k: string) => store.get(k) ?? null),
      setItem: jest.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
      removeItem: jest.fn(async (k: string) => {
        store.delete(k);
      }),
      clear: jest.fn(async () => {
        store.clear();
      }),
    },
  };
});

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  mkdir: jest.fn(async () => {}),
  readFile: jest.fn(async (p: string) => {
    const f = mockFiles.get(p);
    if (f === undefined) {
      throw new Error('ENOENT');
    }
    return f;
  }),
  writeFile: jest.fn(async (p: string, data: string) => {
    mockFiles.set(p, data);
  }),
  moveFile: jest.fn(async (from: string, to: string) => {
    mockFiles.set(to, mockFiles.get(from) ?? '');
    mockFiles.delete(from);
  }),
  unlink: jest.fn(async (p: string) => {
    mockFiles.delete(p);
  }),
  copyFile: jest.fn(async (from: string, to: string) => {
    mockFiles.set(to, mockFiles.get(from) ?? '');
  }),
}));

const mockStitch = jest.fn(async (paths: string[], out: string, trim: number) => ({
  outputPath: out,
  thumbnailPath: out.replace(/\.mp4$/, '.jpg'),
  durationSec: paths.length * 5 - trim,
}));
jest.mock('../src/native/ClipStitcher', () => ({
  stitchSegments: (paths: string[], out: string, trim = 0) =>
    mockStitch(paths, out, trim),
}));

import { CaptureController } from '../src/core/CaptureController';
import { clipStore } from '../src/core/ClipStore';

class FakeSource implements DeviceVideoSource {
  readonly kind = 'mock' as const;
  private onSegment: ((s: Segment) => void) | null = null;
  private counter = 0;

  async prepare() {}
  async start(onSegment: (s: Segment) => void) {
    this.onSegment = onSegment;
  }
  async cut() {
    this.cuts += 1;
    this.emit(); // in-flight segment gets finalized and delivered
  }
  async stop() {
    this.onSegment = null;
  }
  cuts = 0;
  emit(): string {
    const n = this.counter++;
    const path = `/seg_${n}.mp4`;
    this.onSegment?.({ path, startedAt: n * 5000, durationSec: 5 });
    return path;
  }
}

class FakeWakeWord implements WakeWordProvider {
  readonly name = 'fake';
  private cb: ((detection?: WakeDetection) => void) | null = null;
  async start(onDetected: (detection?: WakeDetection) => void) {
    this.cb = onDetected;
  }
  async stop() {
    this.cb = null;
  }
  fire(detection?: WakeDetection) {
    this.cb?.(detection);
  }
}

async function settle() {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe('CaptureController', () => {
  beforeEach(() => {
    mockFiles.clear();
    mockStitch.mockClear();
    clipStore.resetCache();
  });

  it('gives a free-tier clip a 24h retention clock', async () => {
    const source = new FakeSource();
    const wake = new FakeWakeWord();
    const controller = new CaptureController(source, wake, 10);

    await controller.arm();
    for (let i = 0; i < 6; i++) {
      source.emit();
    }
    wake.fire();
    await settle();
    await settle();

    const [clip] = await clipStore.list();
    expect(clip.savedAt).toBeNull();
    expect(clip.expiresAt).toBe(clip.capturedAt + 24 * 3600_000);
  });

  it('wake word auto-saves the look-back window as a clip', async () => {
    const source = new FakeSource();
    const wake = new FakeWakeWord();
    const controller = new CaptureController(source, wake, 10);

    await controller.arm();
    for (let i = 0; i < 6; i++) {
      source.emit(); // 30s buffered, 10s window
    }

    wake.fire();
    await settle();
    await settle();

    expect(mockStitch).toHaveBeenCalledTimes(1);
    // 10s window at 5s segments: the cut in-flight segment + one more cover it
    expect(mockStitch.mock.calls[0][0].length).toBe(2);
    const clips = await clipStore.list();
    expect(clips).toHaveLength(1);
    expect(clips[0].filePath).toMatch(/\.mp4$/);
  });

  it('a timed detection ends the clip on the wake word without cutting', async () => {
    const source = new FakeSource();
    const wake = new FakeWakeWord();
    const controller = new CaptureController(source, wake, 10);

    await controller.arm();
    for (let i = 0; i < 4; i++) {
      source.emit();
    }
    const wakeSegment = source.emit(); // "Clipso" lands 1.2s into this one
    source.emit(); // ...and another segment finishes while it transcribes

    wake.fire({ segmentPath: wakeSegment, endOffsetSec: 1.2 });
    await settle();
    await settle();

    // Everything needed is already on disk, so no cut is forced.
    expect(source.cuts).toBe(0);
    const [paths, , trim] = mockStitch.mock.calls[0];
    // the window ends at the wake segment, not at the newest one
    expect(paths[paths.length - 1]).toBe(wakeSegment);
    // 5s segment, phrase ends at 1.2s, 0.3s padding → drop the last 3.5s
    expect(trim).toBeCloseTo(3.5);
  });

  it('falls back to cut + flush when the wake segment is already gone', async () => {
    const source = new FakeSource();
    const wake = new FakeWakeWord();
    const controller = new CaptureController(source, wake, 10);

    await controller.arm();
    for (let i = 0; i < 6; i++) {
      source.emit();
    }

    wake.fire({ segmentPath: '/seg_0.mp4', endOffsetSec: 1.2 });
    await settle();
    await settle();

    expect(source.cuts).toBe(1);
    expect(mockStitch.mock.calls[0][2]).toBe(0);
  });

  it('extended clip records past the window until stopClip', async () => {
    const source = new FakeSource();
    const wake = new FakeWakeWord();
    const controller = new CaptureController(source, wake, 10);

    await controller.arm();
    source.emit();
    source.emit(); // 10s buffered

    controller.startClip();
    for (let i = 0; i < 5; i++) {
      source.emit(); // 25s of recording after the trigger
    }
    const clip = await controller.stopClip();

    expect(clip).not.toBeNull();
    // look-back (2) + recorded (5) + in-flight cut (1)
    expect(mockStitch.mock.calls[0][0].length).toBe(8);
  });

  it('wake word during an extended recording stops and saves it', async () => {
    const source = new FakeSource();
    const wake = new FakeWakeWord();
    const controller = new CaptureController(source, wake, 10);

    await controller.arm();
    source.emit();
    controller.startClip();
    source.emit();

    wake.fire(); // second detection = stop & save
    await settle();
    await settle();

    expect(mockStitch).toHaveBeenCalledTimes(1);
    const clips = await clipStore.list();
    expect(clips).toHaveLength(1);
  });
});
