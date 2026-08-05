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
  copyFile: jest.fn(async (from: string, to: string) => {
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

/** Stands in for the external captioning infra behind the seam. */
class FakeCaptioner implements CaptioningProvider {
  name = 'http';
  burnsCaptions = true;
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

jest.mock('../src/phase2/PublishService', () => ({
  publishService: { getCaptioner: async () => mockCaptioner },
}));

import { clipStore, deliverablePath, isCaptioning } from '../src/core/ClipStore';
import { entitlementStore } from '../src/core/EntitlementStore';
import { settingsStore } from '../src/core/SettingsStore';
import { captionQueue } from '../src/phase2/CaptionQueue';

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
