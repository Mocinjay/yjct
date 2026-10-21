import type { Clip } from '../src/types';
import type { CaptioningProvider } from '../src/phase2/CaptioningProvider';

const mockFiles = new Map<string, string>();

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  mkdir: jest.fn(async () => {}),
  exists: jest.fn(async (p: string) => mockFiles.has(p)),
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
  // Like iOS (NSFileManager copyItemAtPath:toPath:), refuses to overwrite.
  copyFile: jest.fn(async (from: string, to: string) => {
    if (mockFiles.has(to)) {
      throw new Error(`file already exists: ${to}`);
    }
    mockFiles.set(to, mockFiles.get(from) ?? '');
  }),
  moveFile: jest.fn(async (from: string, to: string) => {
    mockFiles.set(to, mockFiles.get(from) ?? '');
    mockFiles.delete(from);
  }),
  unlink: jest.fn(async (p: string) => {
    if (!mockFiles.has(p)) {
      throw new Error('ENOENT');
    }
    mockFiles.delete(p);
  }),
}));

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

/** Stands in for whichever captioner `getCaptioner()` would pick. */
class FakeCaptioner implements CaptioningProvider {
  name = 'http';
  calls: { path: string; style?: string }[] = [];
  concurrent = 0;
  maxConcurrent = 0;
  failWith: string | null = null;

  async caption(clipFilePath: string, options?: { style?: string }) {
    this.calls.push({ path: clipFilePath, style: options?.style });
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      await Promise.resolve();
      if (this.failWith) {
        throw new Error(this.failWith);
      }
      const captionedFilePath = clipFilePath.replace(
        /\.mp4$/,
        `.captioned.${options?.style ?? 'classic'}.mp4`,
      );
      mockFiles.set(captionedFilePath, 'burned');
      return { captionedFilePath };
    } finally {
      this.concurrent -= 1;
    }
  }
}

const mockCaptioner = new FakeCaptioner();

jest.mock('../src/phase2/captioner', () => ({
  getCaptioner: async () => mockCaptioner,
}));

import { clipStore, deliverablePath, isCaptioning } from '../src/core/ClipStore';
import { entitlementStore } from '../src/core/EntitlementStore';
import { settingsStore } from '../src/core/SettingsStore';
import { captionQueue } from '../src/phase2/CaptionQueue';
import { connectorConfigStore } from '../src/phase2/ConnectorConfig';
import { MockCaptioningProvider } from '../src/phase2/MockCaptioningProvider';

const INDEX = '/docs/clips/index.json';

function makeClip(id: string, over: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    filePath: `/docs/clips/${id}.mp4`,
    thumbnailPath: `/docs/clips/${id}.jpg`,
    capturedAt: 1_000_000,
    durationSec: 30,
    sourceKind: 'mwdat',
    savedAt: 1_000_000,
    expiresAt: null,
    captionState: 'none',
    ...over,
  };
}

function seed(clips: Clip[]): void {
  mockFiles.clear();
  mockFiles.set(INDEX, JSON.stringify(clips));
  for (const c of clips) {
    mockFiles.set(c.filePath, 'video');
    mockFiles.set(c.thumbnailPath, 'jpeg');
  }
  clipStore.resetCache();
}

/** Waits for the queue to go idle — jobs are deliberately fire-and-forget. */
async function drain(): Promise<void> {
  for (let i = 0; i < 500 && captionQueue.depth > 0; i++) {
    await new Promise<void>(resolve => setImmediate(() => resolve()));
  }
  for (let i = 0; i < 5; i++) {
    await new Promise<void>(resolve => setImmediate(() => resolve()));
  }
}

async function clipById(id: string): Promise<Clip> {
  const found = (await clipStore.list()).find(c => c.id === id);
  if (!found) {
    throw new Error(`no clip ${id}`);
  }
  return found;
}

beforeEach(async () => {
  mockCaptioner.calls = [];
  mockCaptioner.failWith = null;
  mockCaptioner.maxConcurrent = 0;
  await entitlementStore.devUnlock();
  await settingsStore.update({ captionStyle: 'classic' });
});

describe('auto-captioning', () => {
  it('captions a freshly captured clip without being asked', async () => {
    seed([makeClip('a')]);

    await captionQueue.enqueue('a');
    await drain();

    const clip = await clipById('a');
    expect(clip.captionState).toBe('ready');
    expect(clip.captionedFilePath).toBe('/docs/clips/a.captioned.classic.mp4');
    expect(clip.captionStyle).toBe('classic');
    expect(clip.captionProvider).toBe('http');
    expect(clip.captionError).toBeNull();
  });

  it('burns the style chosen in settings', async () => {
    seed([makeClip('a')]);
    await settingsStore.update({ captionStyle: 'boxed' });

    await captionQueue.enqueue('a');
    await drain();

    expect(mockCaptioner.calls[0].style).toBe('boxed');
    expect((await clipById('a')).captionStyle).toBe('boxed');
  });

  it('marks the clip as in-flight so the library can say so', async () => {
    seed([makeClip('a')]);

    await captionQueue.enqueue('a');
    expect(isCaptioning(await clipById('a'))).toBe(true);

    await drain();
    expect(isCaptioning(await clipById('a'))).toBe(false);
  });

  it('runs one job at a time', async () => {
    seed([makeClip('a'), makeClip('b'), makeClip('c')]);

    await Promise.all(['a', 'b', 'c'].map(id => captionQueue.enqueue(id)));
    await drain();

    expect(mockCaptioner.maxConcurrent).toBe(1);
    expect(mockCaptioner.calls).toHaveLength(3);
  });

  it('does not caption for free tier', async () => {
    await entitlementStore.clear();
    seed([makeClip('a')]);

    await captionQueue.enqueue('a');
    await drain();

    expect(mockCaptioner.calls).toHaveLength(0);
    expect((await clipById('a')).captionState).toBe('none');
  });

  it('skips a clip that is already captioned', async () => {
    seed([
      makeClip('a', {
        captionState: 'ready',
        captionedFilePath: '/docs/clips/a.captioned.classic.mp4',
      }),
    ]);

    await captionQueue.enqueue('a');
    await drain();

    expect(mockCaptioner.calls).toHaveLength(0);
  });

  it('survives the clip being deleted mid-job, leaving no orphan file', async () => {
    seed([makeClip('a')]);

    await captionQueue.enqueue('a');
    await clipStore.remove('a');
    await drain();

    expect(await clipStore.list()).toEqual([]);
    expect(mockFiles.has('/docs/clips/a.captioned.classic.mp4')).toBe(false);
  });
});

describe('while the glasses are recording', () => {
  afterEach(() => {
    captionQueue.setCaptureActive(false);
  });

  /** A few turns of the event loop: long enough for a job that could start to. */
  async function idle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await new Promise<void>(resolve => setImmediate(() => resolve()));
    }
  }

  it('holds new clips until capture ends, then captions them', async () => {
    seed([makeClip('a')]);
    captionQueue.setCaptureActive(true);

    await captionQueue.enqueue('a');
    await idle();

    expect(mockCaptioner.calls).toHaveLength(0);
    expect((await clipById('a')).captionState).toBe('queued');

    captionQueue.setCaptureActive(false);
    await drain();

    expect(mockCaptioner.calls).toHaveLength(1);
    expect((await clipById('a')).captionState).toBe('ready');
  });

  it('lets a running job finish but starts no more until capture ends', async () => {
    seed([makeClip('a'), makeClip('b')]);

    await Promise.all(['a', 'b'].map(id => captionQueue.enqueue(id)));
    captionQueue.setCaptureActive(true);
    await idle();

    expect(mockCaptioner.calls.map(c => c.path)).toEqual(['/docs/clips/a.mp4']);
    expect((await clipById('a')).captionState).toBe('ready');
    expect((await clipById('b')).captionState).toBe('queued');

    captionQueue.setCaptureActive(false);
    await drain();

    expect(mockCaptioner.calls).toHaveLength(2);
    expect((await clipById('b')).captionState).toBe('ready');
  });
});

describe('failure handling', () => {
  it('records why captioning failed instead of swallowing it', async () => {
    seed([makeClip('a')]);
    mockCaptioner.failWith = 'HTTP 502';

    await captionQueue.enqueue('a');
    await drain();

    const clip = await clipById('a');
    expect(clip.captionState).toBe('failed');
    expect(clip.captionError).toBe('HTTP 502');
  });

  it('retry clears the error and re-runs', async () => {
    seed([makeClip('a')]);
    mockCaptioner.failWith = 'HTTP 502';
    await captionQueue.enqueue('a');
    await drain();

    mockCaptioner.failWith = null;
    await captionQueue.retry('a');
    await drain();

    const clip = await clipById('a');
    expect(clip.captionState).toBe('ready');
    expect(clip.captionError).toBeNull();
  });

  it('a failed clip still plays and shares as the raw capture', async () => {
    seed([makeClip('a')]);
    mockCaptioner.failWith = 'nope';

    await captionQueue.enqueue('a');
    await drain();

    expect(deliverablePath(await clipById('a'))).toBe('/docs/clips/a.mp4');
  });
});

describe('restyling', () => {
  it('replaces the previous burn-in rather than accumulating files', async () => {
    seed([makeClip('a')]);
    await captionQueue.enqueue('a');
    await drain();
    expect(mockFiles.has('/docs/clips/a.captioned.classic.mp4')).toBe(true);

    await settingsStore.update({ captionStyle: 'clean' });
    await captionQueue.retry('a');
    await drain();

    expect(mockFiles.has('/docs/clips/a.captioned.classic.mp4')).toBe(false);
    expect(mockFiles.has('/docs/clips/a.captioned.clean.mp4')).toBe(true);
    expect((await clipById('a')).captionStyle).toBe('clean');
  });

  it('deleting a clip takes its captioned copy with it', async () => {
    seed([makeClip('a')]);
    await captionQueue.enqueue('a');
    await drain();

    await clipStore.remove('a');

    expect(mockFiles.has('/docs/clips/a.captioned.classic.mp4')).toBe(false);
    expect(mockFiles.has('/docs/clips/a.mp4')).toBe(false);
  });

  it('captions the full-resolution cut when it replaces the clip mid-render', async () => {
    seed([makeClip('a', { quality: 'proxy' })]);
    mockFiles.set('/docs/clips/m.mp4', 'master');
    const realCaption = mockCaptioner.caption.bind(mockCaptioner);
    let upgraded = false;
    const spy = jest
      .spyOn(mockCaptioner, 'caption')
      .mockImplementation(async (path, options) => {
        if (!upgraded) {
          // The glasses' own recording lands while the 720p clip renders.
          upgraded = true;
          await clipStore.replaceWithMaster('a', {
            filePath: '/docs/clips/m.mp4',
            thumbnailPath: '/docs/clips/m.jpg',
            durationSec: 30,
          });
        }
        return realCaption(path, options);
      });
    try {
      await captionQueue.enqueue('a');
      await drain();
    } finally {
      spy.mockRestore();
    }

    const clip = await clipById('a');
    expect(clip.quality).toBe('master');
    expect(clip.captionState).toBe('ready');
    expect(clip.captionedFilePath).toBe('/docs/clips/m.captioned.classic.mp4');
    // The 720p burn is not left behind.
    expect(mockFiles.has('/docs/clips/a.captioned.classic.mp4')).toBe(false);
  });

  it('never deletes a source the clip also records as its captioned cut', async () => {
    // A dev test render is stored this way: its source is already burned in.
    seed([
      makeClip('a', {
        filePath: '/docs/clips/a.rendered.mp4',
        captionState: 'ready',
        captionedFilePath: '/docs/clips/a.rendered.mp4',
      }),
    ]);

    await captionQueue.retry('a');
    await drain();

    const clip = await clipById('a');
    expect(clip.captionedFilePath).toBe('/docs/clips/a.rendered.captioned.classic.mp4');
    expect(mockFiles.has('/docs/clips/a.rendered.mp4')).toBe(true);
  });
});

describe('resuming after the app was killed', () => {
  it('re-runs a job that was left mid-flight', async () => {
    // What the index looks like if the app died during captioning: state says
    // processing, but no worker exists any more.
    seed([makeClip('a', { captionState: 'processing' })]);

    await captionQueue.resume();
    await drain();

    expect((await clipById('a')).captionState).toBe('ready');
  });

  it('picks up a clip that never got started', async () => {
    seed([makeClip('a', { captionState: 'queued' })]);

    await captionQueue.resume();
    await drain();

    expect(mockCaptioner.calls).toHaveLength(1);
  });

  it('clears stranded jobs rather than spinning forever when Pro has lapsed', async () => {
    seed([makeClip('a', { captionState: 'processing' })]);
    await entitlementStore.clear();

    await captionQueue.resume();
    await drain();

    expect((await clipById('a')).captionState).toBe('none');
    expect(mockCaptioner.calls).toHaveLength(0);
  });

  it('leaves finished and untouched clips alone', async () => {
    seed([
      makeClip('done', {
        captionState: 'ready',
        captionedFilePath: '/docs/clips/done.captioned.classic.mp4',
      }),
      makeClip('never', { captionState: 'none' }),
    ]);

    await captionQueue.resume();
    await drain();

    expect(mockCaptioner.calls).toHaveLength(0);
  });
});

describe('deliverablePath', () => {
  it('is the captioned cut once it exists, the raw capture until then', () => {
    const raw = makeClip('a');
    expect(deliverablePath(raw)).toBe('/docs/clips/a.mp4');

    const pending = makeClip('a', {
      captionState: 'processing',
      captionedFilePath: '/docs/clips/a.captioned.classic.mp4',
    });
    expect(deliverablePath(pending)).toBe('/docs/clips/a.mp4');

    const ready = makeClip('a', {
      captionState: 'ready',
      captionedFilePath: '/docs/clips/a.captioned.classic.mp4',
    });
    expect(deliverablePath(ready)).toBe('/docs/clips/a.captioned.classic.mp4');
  });
});

describe('captionNow (publishing)', () => {
  afterEach(() => {
    captionQueue.setCaptureActive(false);
  });

  it('captions on demand and resolves with the finished clip', async () => {
    seed([makeClip('a')]);

    const clip = await captionQueue.captionNow('a');

    expect(clip?.captionState).toBe('ready');
    expect(clip?.captionedFilePath).toBe('/docs/clips/a.captioned.classic.mp4');
    expect(mockCaptioner.calls).toHaveLength(1);
  });

  it('joins the job already in flight instead of rendering twice', async () => {
    seed([makeClip('a')]);

    await captionQueue.enqueue('a');
    const clip = await captionQueue.captionNow('a');

    expect(mockCaptioner.calls).toHaveLength(1);
    expect(clip?.captionState).toBe('ready');
  });

  it('returns an already-ready clip without re-rendering', async () => {
    seed([
      makeClip('a', {
        captionState: 'ready',
        captionedFilePath: '/docs/clips/a.captioned.classic.mp4',
      }),
    ]);

    const clip = await captionQueue.captionNow('a');

    expect(mockCaptioner.calls).toHaveLength(0);
    expect(clip?.captionedFilePath).toBe('/docs/clips/a.captioned.classic.mp4');
  });

  it('refuses while capture is live rather than hanging on the hold', async () => {
    seed([makeClip('a')]);
    captionQueue.setCaptureActive(true);

    await expect(captionQueue.captionNow('a')).rejects.toThrow(/recording/);

    expect(mockCaptioner.calls).toHaveLength(0);
    expect((await clipById('a')).captionState).toBe('none');
  });

  it('jumps ahead of clips queued in the background', async () => {
    seed([makeClip('a'), makeClip('b'), makeClip('c')]);
    captionQueue.setCaptureActive(true);
    for (const id of ['a', 'b', 'c']) {
      await captionQueue.enqueue(id);
    }
    captionQueue.setCaptureActive(false);

    await captionQueue.captionNow('c');
    await drain();

    // 'a' was already running when the publish asked; 'c' goes next, not 'b'.
    expect(mockCaptioner.calls.map(c => c.path)).toEqual([
      '/docs/clips/a.mp4',
      '/docs/clips/c.mp4',
      '/docs/clips/b.mp4',
    ]);
  });

  it('resolves for a clip that no longer exists', async () => {
    seed([]);

    await expect(captionQueue.captionNow('gone')).resolves.toBeUndefined();
  });

  it('is released when the claim it joined ends without a job', async () => {
    // enqueue() has claimed the clip and is still reading the index when the
    // publish asks. That push then finds no clip and queues nothing, so no job
    // will ever settle the publish; the push itself has to.
    seed([]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const list = clipStore.list.bind(clipStore);
    const spy = jest.spyOn(clipStore, 'list').mockImplementationOnce(async () => {
      await gate;
      return list();
    });
    try {
      const enqueued = captionQueue.enqueue('gone');
      for (let i = 0; i < 50 && captionQueue.depth === 0; i++) {
        await new Promise<void>(resolve => setImmediate(() => resolve()));
      }
      expect(captionQueue.depth).toBe(1);

      const asked = captionQueue.captionNow('gone');
      release();
      await enqueued;

      const hung = new Promise<'hung'>(resolve =>
        setTimeout(() => resolve('hung'), 100),
      );
      await expect(Promise.race([asked, hung])).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('surfaces a failed job to the caller', async () => {
    seed([makeClip('a')]);
    mockCaptioner.failWith = 'no speech engine';

    const clip = await captionQueue.captionNow('a');

    expect(clip?.captionState).toBe('failed');
    expect(clip?.captionError).toBe('no speech engine');
  });
});

describe('MockCaptioningProvider', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('replaces its own earlier copy on a same-style re-run', async () => {
    // Recaption without changing style, or a job resumed after the app was
    // killed mid-copy: the output path already exists, and copyFile on iOS
    // will not overwrite it.
    seed([makeClip('a')]);
    mockFiles.set('/docs/clips/a.captioned.classic.mp4', 'stale copy');
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });

    const captioning = new MockCaptioningProvider().caption('/docs/clips/a.mp4', {
      style: 'classic',
    });
    await jest.advanceTimersByTimeAsync(1000);

    await expect(captioning).resolves.toEqual({
      captionedFilePath: '/docs/clips/a.captioned.classic.mp4',
    });
    expect(mockFiles.get('/docs/clips/a.captioned.classic.mp4')).toBe('video');
  });
});

describe('getCaptioner', () => {
  const { getCaptioner } = jest.requireActual<
    typeof import('../src/phase2/captioner')
  >('../src/phase2/captioner');
  const dev = __DEV__;

  afterEach(async () => {
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = dev;
    await connectorConfigStore.update({ captioningUrl: undefined });
  });

  // Jest has no CaptionEngine native module, so on-device is never usable here.

  it('uses the captioning service when one is configured', async () => {
    await connectorConfigStore.update({ captioningUrl: 'http://captions.local' });

    expect((await getCaptioner()).name).toBe('http');
  });

  it('falls back to the mock in dev builds', async () => {
    expect((await getCaptioner()).name).toBe('mock');
  });

  it('fails the job in release builds instead of faking a caption', async () => {
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;

    await expect(getCaptioner()).rejects.toThrow(/no captioning service URL/);
  });
});
