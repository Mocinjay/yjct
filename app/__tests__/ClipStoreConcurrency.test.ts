const mockFiles = new Map<string, string>();
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

// iOS semantics: NSFileManager.moveItemAtPath fails when the destination
// exists or the source is missing. Every call takes a turn of the event loop,
// like a bridge round trip, so overlapping callers really interleave.
jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  mkdir: jest.fn(async () => {
    await tick();
  }),
  exists: jest.fn(async (p: string) => {
    await tick();
    return mockFiles.has(p);
  }),
  readFile: jest.fn(async (p: string) => {
    await tick();
    const f = mockFiles.get(p);
    if (f === undefined) {
      throw new Error('ENOENT');
    }
    return f;
  }),
  writeFile: jest.fn(async (p: string, data: string) => {
    await tick();
    mockFiles.set(p, data);
  }),
  moveFile: jest.fn(async (from: string, to: string) => {
    await tick();
    if (!mockFiles.has(from)) {
      throw new Error(`ENOENT ${from}`);
    }
    if (mockFiles.has(to)) {
      throw new Error(`EEXIST ${to}`);
    }
    mockFiles.set(to, mockFiles.get(from)!);
    mockFiles.delete(from);
  }),
  unlink: jest.fn(async (p: string) => {
    await tick();
    if (!mockFiles.delete(p)) {
      throw new Error('ENOENT');
    }
  }),
}));

import { ClipStore } from '../src/core/ClipStore';
import type { Clip } from '../src/types';

const INDEX = '/docs/clips/index.json';

function clip(id: string, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    filePath: `/docs/clips/${id}.mp4`,
    thumbnailPath: `/docs/clips/${id}.jpg`,
    capturedAt: 1,
    durationSec: 5,
    sourceKind: 'mwdat',
    savedAt: null,
    expiresAt: 10_000,
    ...extra,
  };
}

function onDisk(): Clip[] {
  return JSON.parse(mockFiles.get(INDEX)!);
}

describe('ClipStore concurrency', () => {
  beforeEach(() => mockFiles.clear());

  it('two overlapping writes both land on disk', async () => {
    const store = new ClipStore();
    await store.add(clip('a'));

    await Promise.all([store.add(clip('b')), store.save('a')]);

    const saved = onDisk();
    expect(saved.map(c => c.id).sort()).toEqual(['a', 'b']);
    expect(saved.find(c => c.id === 'a')!.expiresAt).toBeNull();
  });

  it('concurrent first reads do not bring back a swept clip', async () => {
    const seed = new ClipStore();
    await seed.add(clip('old', { expiresAt: 5 }));
    await seed.add(clip('new', { expiresAt: null, savedAt: 1 }));

    // App launch: the sweep and the caption queue's resume both read first.
    const store = new ClipStore();
    await Promise.all([store.sweepExpired(100), store.list()]);

    expect((await store.list()).map(c => c.id)).toEqual(['new']);
    expect(onDisk().map(c => c.id)).toEqual(['new']);
  });

  it('counts a launch sweep still writing when the Library sweep returns', async () => {
    const seed = new ClipStore();
    await seed.add(clip('old', { expiresAt: 5 }));

    const store = new ClipStore();
    // App launch sweep, then the Library's focus sweep before the first one's
    // index write has landed.
    const launch = store.sweepExpired(100);
    expect(await store.sweepExpired(100)).toEqual([]);

    expect(store.takeUnreportedExpired()).toBe(1);
    await launch;
    expect(store.takeUnreportedExpired()).toBe(0);
  });

  it('removing an unknown clip neither writes nor notifies', async () => {
    const store = new ClipStore();
    await store.add(clip('a'));
    const notified = jest.fn();
    store.subscribe(notified);

    await store.remove('missing');

    expect(notified).not.toHaveBeenCalled();
    expect(onDisk().map(c => c.id)).toEqual(['a']);
  });
});

describe('replaceWithMaster', () => {
  beforeEach(() => mockFiles.clear());

  it('upgrades a 720p clip in place and deletes its files', async () => {
    const store = new ClipStore();
    await store.add(
      clip('a', {
        name: 'Beach',
        savedAt: 5,
        expiresAt: null,
        publishedTo: ['youtube'],
        quality: 'proxy',
        captionState: 'ready',
        captionedFilePath: '/docs/clips/a.captioned.classic.mp4',
        captionProvider: 'on-device',
      }),
    );
    for (const path of ['/docs/clips/a.mp4', '/docs/clips/a.jpg', '/docs/clips/a.captioned.classic.mp4']) {
      mockFiles.set(path, 'proxy');
    }

    const replaced = await store.replaceWithMaster('a', {
      filePath: '/docs/clips/m.mp4',
      thumbnailPath: '/docs/clips/m.jpg',
      durationSec: 30,
    });

    expect(replaced).toBe(true);
    const [upgraded] = onDisk();
    expect(upgraded).toMatchObject({
      id: 'a',
      name: 'Beach',
      savedAt: 5,
      expiresAt: null,
      publishedTo: ['youtube'],
      filePath: '/docs/clips/m.mp4',
      thumbnailPath: '/docs/clips/m.jpg',
      durationSec: 30,
      sourceKind: 'glasses-library',
      quality: 'master',
      // Captions burned into 720p pixels do not carry over.
      captionState: 'none',
      captionedFilePath: null,
    });
    expect(mockFiles.has('/docs/clips/a.mp4')).toBe(false);
    expect(mockFiles.has('/docs/clips/a.jpg')).toBe(false);
    expect(mockFiles.has('/docs/clips/a.captioned.classic.mp4')).toBe(false);
  });

  it('changes nothing when the 720p clip is gone', async () => {
    const store = new ClipStore();
    await store.add(clip('b'));

    expect(
      await store.replaceWithMaster('a', {
        filePath: '/docs/clips/m.mp4',
        thumbnailPath: '/docs/clips/m.jpg',
        durationSec: 30,
      }),
    ).toBe(false);
    expect(onDisk().map(c => c.id)).toEqual(['b']);
  });
});
