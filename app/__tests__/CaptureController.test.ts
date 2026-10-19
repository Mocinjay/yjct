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

import {
  CaptureController,
  isCaptureLive,
  type CaptureStatus,
} from '../src/core/CaptureController';
import { clipStore } from '../src/core/ClipStore';
import { entitlementStore } from '../src/core/EntitlementStore';

class FakeSource implements DeviceVideoSource {
  readonly kind = 'mock' as const;
  private onSegment: ((s: Segment) => void) | null = null;
  private counter = 0;

  async prepare() {}
  private onError: ((e: Error) => void) | null = null;
  async start(onSegment: (s: Segment) => void, onError?: (e: Error) => void) {
    this.onSegment = onSegment;
    this.onError = onError ?? null;
  }
  fail(message: string) {
    this.onError?.(new Error(message));
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
  beforeEach(async () => {
    mockFiles.clear();
    mockStitch.mockClear();
    clipStore.resetCache();
    // Debug builds are Pro by default and jest defines __DEV__, so the free
    // tier has to be asked for explicitly — otherwise the retention
    // expectation below silently exercises the Pro path instead.
    await entitlementStore.clear();
  });

  it('gives a free-tier clip a 24h retention clock', async () => {
    const source = new FakeSource();
    const wake = new FakeWakeWord();
    const controller = new CaptureController(source, wake, 10, false);

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
    const controller = new CaptureController(source, wake, 10, false);

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
    const controller = new CaptureController(source, wake, 10, false);

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

  it('saves a wake word heard while capture is down, without waiting for a re-arm', async () => {
    const source = new FakeSource();
    const wake = new FakeWakeWord();
    const controller = new CaptureController(source, wake, 10, false);
    const states: string[] = [];
    controller.subscribe(s => states.push(s.state));

    await controller.arm();
    for (let i = 0; i < 3; i++) {
      source.emit();
    }
    const wakeSegment = source.emit();
    // The feed drops; the segment holding "Clipso" is only transcribed after
    // the error has landed.
    source.fail('The glasses feed stalled');
    wake.fire({ segmentPath: wakeSegment, endOffsetSec: 1.2 });
    await settle();
    await settle();

    expect(mockStitch).toHaveBeenCalledTimes(1);
    const [paths, , trim] = mockStitch.mock.calls[0];
    expect(paths[paths.length - 1]).toBe(wakeSegment);
    expect(trim).toBeCloseTo(3.5);
    // The recovery state is left for the capture screen to handle.
    expect(states[states.length - 1]).toBe('error');
    expect(await clipStore.list()).toHaveLength(1);
  });

  it('a wake word while down stops an interrupted extended recording whole', async () => {
    const source = new FakeSource();
    const wake = new FakeWakeWord();
    const controller = new CaptureController(source, wake, 10, false);

    await controller.arm();
    source.emit();
    source.emit();
    controller.startClip();
    const recorded: string[] = [];
    for (let i = 0; i < 6; i++) {
      recorded.push(source.emit());
    }
    source.fail('The glasses feed stalled');
    wake.fire({ segmentPath: recorded[recorded.length - 1], endOffsetSec: 1 });
    await settle();
    await settle();

    try {
      expect(mockStitch).toHaveBeenCalledTimes(1);
      const [paths] = mockStitch.mock.calls[0];
      // The pinned look-back and every recorded segment, not just one window.
      expect(paths.length).toBeGreaterThanOrEqual(recorded.length);
      expect(paths.slice(-recorded.length)).toEqual(recorded);
    } finally {
      // Clears the extended recording's safety timer even on failure, or jest
      // waits out its 180s.
      await controller.disarm();
    }
  });

  it('falls back to cut + flush when the wake segment is already gone', async () => {
    const source = new FakeSource();
    const wake = new FakeWakeWord();
    const controller = new CaptureController(source, wake, 10, false);

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
    const controller = new CaptureController(source, wake, 10, false);

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
    const controller = new CaptureController(source, wake, 10, false);

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

  it('a superseded arm that fails late leaves the newer arm armed', async () => {
    const source = new FakeSource();
    const wake = new FakeWakeWord();
    const controller = new CaptureController(source, wake, 10, false);
    const states: string[] = [];
    controller.subscribe(s => states.push(s.state));
    const realStart = source.start.bind(source);
    let rejectFirst: (e: Error) => void = () => {};
    let calls = 0;
    source.start = async (onSegment, onError) => {
      calls += 1;
      await realStart(onSegment, onError);
      if (calls === 1) {
        await new Promise<void>((_, reject) => {
          rejectFirst = reject;
        });
      }
    };

    const first = controller.arm();
    await settle();
    await controller.arm();
    rejectFirst(new Error('stale open failed'));
    await first;

    expect(states[states.length - 1]).toBe('armed');
    // Still capturing: the wake word saves the window.
    source.emit();
    wake.fire();
    await settle();
    await settle();
    expect(mockStitch).toHaveBeenCalledTimes(1);
    await controller.disarm();
  });

  it('a disarm while an arm is in flight is not undone by that arm', async () => {
    const source = new FakeSource();
    const wake = new FakeWakeWord();
    const controller = new CaptureController(source, wake, 10, false);
    const states: string[] = [];
    controller.subscribe(s => states.push(s.state));
    const realStart = source.start.bind(source);
    let resolveStart: () => void = () => {};
    source.start = async (onSegment, onError) => {
      await realStart(onSegment, onError);
      await new Promise<void>(resolve => {
        resolveStart = resolve;
      });
    };

    const arming = controller.arm();
    await settle();
    await controller.disarm();
    resolveStart();
    await arming;

    expect(states[states.length - 1]).toBe('idle');
  });

  it('a re-arm after a feed drop carries on an interrupted extended recording', async () => {
    const source = new FakeSource();
    const wake = new FakeWakeWord();
    const controller = new CaptureController(source, wake, 10, false);
    let last: CaptureStatus | null = null;
    controller.subscribe(s => {
      last = s;
    });

    await controller.arm();
    source.emit();
    source.emit();
    controller.startClip();
    const since = last!.recordingSince;
    const recorded: string[] = [];
    for (let i = 0; i < 3; i++) {
      recorded.push(source.emit());
    }
    source.fail('The glasses feed stalled');
    await controller.arm();

    try {
      expect(last!.state).toBe('recording');
      expect(last!.recordingSince).toBe(since);
      for (let i = 0; i < 2; i++) {
        recorded.push(source.emit());
      }
      wake.fire(); // the stop word
      await settle();
      await settle();

      expect(mockStitch).toHaveBeenCalledTimes(1);
      const [paths] = mockStitch.mock.calls[0];
      // look-back (2) + recorded across the drop (5) + in-flight cut (1)
      expect(paths).toHaveLength(8);
      expect(paths.slice(2, 7)).toEqual(recorded);
    } finally {
      await controller.disarm();
    }
  });
});

describe('isCaptureLive', () => {
  beforeEach(() => {
    mockFiles.clear();
    clipStore.resetCache();
  });

  it('is true from arming until disarm, and false again after', async () => {
    const controller = new CaptureController(
      new FakeSource(),
      new FakeWakeWord(),
      10,
      false,
    );
    const seen: boolean[] = [];
    controller.subscribe(s => seen.push(isCaptureLive(s)));

    await controller.arm();
    expect(seen[seen.length - 1]).toBe(true);
    await controller.disarm();

    // idle → arming → armed → idle
    expect(seen).toEqual([false, true, true, false]);
  });

  it('stays true when a stream error lands mid-session', () => {
    expect(
      isCaptureLive({
        state: 'error',
        bufferedSeconds: 0,
        bufferedAsOf: 0,
        armedSince: 1,
      }),
    ).toBe(true);
  });

  it('is false after an arm that failed', async () => {
    const source = new FakeSource();
    source.prepare = async () => {
      throw new Error('no glasses');
    };
    const controller = new CaptureController(
      source,
      new FakeWakeWord(),
      10,
      false,
    );
    let last = true;
    controller.subscribe(s => {
      last = isCaptureLive(s);
    });

    await expect(controller.arm()).rejects.toThrow('no glasses');
    expect(last).toBe(false);
  });
});
