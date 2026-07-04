import type { DeviceVideoSource } from '../src/device/DeviceVideoSource';
import type { Segment } from '../src/types';
import type { WakeWordProvider } from '../src/wakeword/WakeWordProvider';

const mockFiles = new Map<string, string>();

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

const mockStitch = jest.fn(async (paths: string[], out: string) => ({
  outputPath: out,
  thumbnailPath: out.replace(/\.mp4$/, '.jpg'),
  durationSec: paths.length * 5,
}));
jest.mock('../src/native/ClipStitcher', () => ({
  stitchSegments: (paths: string[], out: string) => mockStitch(paths, out),
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
    this.emit(); // in-flight segment gets finalized and delivered
  }
  async stop() {
    this.onSegment = null;
  }
  emit() {
    const n = this.counter++;
    this.onSegment?.({ path: `/seg_${n}.mp4`, startedAt: n * 5000, durationSec: 5 });
  }
}

class FakeWakeWord implements WakeWordProvider {
  readonly name = 'fake';
  private cb: (() => void) | null = null;
  async start(onDetected: () => void) {
    this.cb = onDetected;
  }
  async stop() {
    this.cb = null;
  }
  fire() {
    this.cb?.();
  }
}

async function settle() {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe('CaptureController', () => {
  beforeEach(() => {
    mockFiles.clear();
    mockStitch.mockClear();
    // reset the singleton store's cache between tests
    (clipStore as unknown as { clips: unknown }).clips = null;
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
