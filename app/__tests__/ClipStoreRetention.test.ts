import type { Clip } from '../src/types';

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

import { clipStore, isPending, msUntilExpiry } from '../src/core/ClipStore';

const INDEX = '/docs/clips/index.json';
const BACKUP = '/docs/clips/index.bak.json';
const HOUR = 3600_000;

function makeClip(id: string, over: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    filePath: `/docs/clips/${id}.mp4`,
    thumbnailPath: `/docs/clips/${id}.jpg`,
    capturedAt: 1_000_000,
    durationSec: 30,
    sourceKind: 'mock',
    savedAt: null,
    expiresAt: 1_000_000 + 24 * HOUR,
    ...over,
  };
}

/** Seeds the index and the clip's media files, then clears the store cache. */
function seed(clips: Clip[]): void {
  mockFiles.clear();
  mockFiles.set(INDEX, JSON.stringify(clips));
  for (const c of clips) {
    mockFiles.set(c.filePath, 'video');
    mockFiles.set(c.thumbnailPath, 'jpeg');
  }
  clipStore.resetCache();
}

beforeEach(() => {
  mockFiles.clear();
  clipStore.resetCache();
});

describe('retention', () => {
  it('sweeps clips past their deadline and deletes their files', async () => {
    const stale = makeClip('stale', { expiresAt: 500 });
    const fresh = makeClip('fresh', { expiresAt: 10_000 });
    seed([stale, fresh]);

    const expired = await clipStore.sweepExpired(1_000);

    expect(expired.map(c => c.id)).toEqual(['stale']);
    expect((await clipStore.list()).map(c => c.id)).toEqual(['fresh']);
    expect(mockFiles.has(stale.filePath)).toBe(false);
    expect(mockFiles.has(stale.thumbnailPath)).toBe(false);
    expect(mockFiles.has(fresh.filePath)).toBe(true);
  });

  it('never sweeps a saved clip, however old', async () => {
    seed([makeClip('kept', { savedAt: 1, expiresAt: null })]);

    expect(await clipStore.sweepExpired(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(await clipStore.list()).toHaveLength(1);
  });

  it('save() clears the clock', async () => {
    seed([makeClip('a')]);

    await clipStore.save('a');

    const [clip] = await clipStore.list();
    expect(clip.expiresAt).toBeNull();
    expect(clip.savedAt).not.toBeNull();
    expect(isPending(clip)).toBe(false);
    expect(await clipStore.sweepExpired(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('publishing implicitly saves', async () => {
    seed([makeClip('a')]);

    await clipStore.markPublished('a', 'youtube');

    const [clip] = await clipStore.list();
    expect(clip.expiresAt).toBeNull();
    expect(clip.publishedTo).toEqual(['youtube']);
  });

  it('does not duplicate a platform on republish', async () => {
    seed([makeClip('a')]);

    await clipStore.markPublished('a', 'youtube');
    await clipStore.markPublished('a', 'youtube');

    expect((await clipStore.list())[0].publishedTo).toEqual(['youtube']);
  });

  it('rescueExpiring() keeps everything mid-countdown', async () => {
    seed([makeClip('a'), makeClip('b'), makeClip('c', { savedAt: 1, expiresAt: null })]);

    expect(await clipStore.rescueExpiring()).toBe(2);
    expect((await clipStore.list()).every(c => c.expiresAt === null)).toBe(true);
  });

  it('treats pre-retention clips as saved rather than instantly expired', async () => {
    // Written by a build that predates retention: neither field exists.
    const legacy = {
      id: 'old',
      name: 'old',
      filePath: '/docs/clips/old.mp4',
      thumbnailPath: '/docs/clips/old.jpg',
      capturedAt: 42,
      durationSec: 30,
      sourceKind: 'mock',
    };
    mockFiles.set(INDEX, JSON.stringify([legacy]));
    clipStore.resetCache();

    const [clip] = await clipStore.list();
    expect(clip.expiresAt).toBeNull();
    expect(clip.savedAt).toBe(42);
    expect(await clipStore.sweepExpired(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('msUntilExpiry reports null for saved clips', () => {
    expect(msUntilExpiry(makeClip('a', { expiresAt: null }))).toBeNull();
    expect(msUntilExpiry(makeClip('a', { expiresAt: 5_000 }), 1_000)).toBe(4_000);
  });
});

describe('index durability', () => {
  it('recovers the library from the backup when the index is lost', async () => {
    seed([makeClip('a')]);
    // A write leaves the previous index in the backup slot.
    await clipStore.save('a');
    expect(mockFiles.has(BACKUP)).toBe(true);

    // Simulate a kill in the window where the new index never landed.
    mockFiles.delete(INDEX);
    clipStore.resetCache();

    expect((await clipStore.list()).map(c => c.id)).toEqual(['a']);
  });

  it('falls back to an empty library if both copies are gone', async () => {
    clipStore.resetCache();
    expect(await clipStore.list()).toEqual([]);
  });
});
