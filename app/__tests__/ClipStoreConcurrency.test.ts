import type { Clip } from '../src/types';

/**
 * The mock deliberately makes every filesystem call yield.
 *
 * The bug this file covers only exists when two persists interleave, and they
 * can only interleave if an `await` inside one gives the other a turn. A mock
 * whose promises resolve synchronously never produces that interleaving, so the
 * race is invisible — which is why the original suite passed while the store
 * was losing writes on device.
 */
const mockFiles = new Map<string, string>();

const yieldTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0));

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  mkdir: jest.fn(async () => {
    await yieldTurn();
  }),
  exists: jest.fn(async (p: string) => {
    await yieldTurn();
    return mockFiles.has(p);
  }),
  readFile: jest.fn(async (p: string) => {
    await yieldTurn();
    const f = mockFiles.get(p);
    if (f === undefined) {
      throw new Error('ENOENT');
    }
    return f;
  }),
  writeFile: jest.fn(async (p: string, data: string) => {
    await yieldTurn();
    mockFiles.set(p, data);
  }),
  moveFile: jest.fn(async (from: string, to: string) => {
    await yieldTurn();
    if (!mockFiles.has(from)) {
      throw new Error(`ENOENT: no such file, rename '${from}'`);
    }
    mockFiles.set(to, mockFiles.get(from)!);
    mockFiles.delete(from);
  }),
  unlink: jest.fn(async (p: string) => {
    await yieldTurn();
    if (!mockFiles.has(p)) {
      throw new Error('ENOENT');
    }
    mockFiles.delete(p);
  }),
}));

import { clipStore } from '../src/core/ClipStore';

const INDEX = '/docs/clips/index.json';

function makeClip(id: string): Clip {
  return {
    id,
    name: id,
    filePath: `/docs/clips/${id}.mp4`,
    thumbnailPath: `/docs/clips/${id}.jpg`,
    capturedAt: 1_000_000,
    durationSec: 30,
    sourceKind: 'mock',
    savedAt: null,
    expiresAt: null,
  };
}

function readIndexFile(): Clip[] {
  return JSON.parse(mockFiles.get(INDEX) ?? '[]');
}

beforeEach(() => {
  mockFiles.clear();
  clipStore.resetCache();
});

describe('ClipStore concurrent writes', () => {
  it('keeps every clip when adds are issued without awaiting each other', async () => {
    // Capture calls add() while CaptionQueue calls setCaptionState() on its own
    // schedule. Both used one shared `.tmp` path, so the second writer moved a
    // file the first had already consumed.
    await Promise.all([
      clipStore.add(makeClip('a')),
      clipStore.add(makeClip('b')),
      clipStore.add(makeClip('c')),
    ]);

    const ids = readIndexFile().map(c => c.id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('leaves the on-disk index matching memory after interleaved writes', async () => {
    await clipStore.add(makeClip('a'));

    await Promise.all([
      clipStore.rename('a', 'renamed'),
      clipStore.setCaptionState('a', { captionState: 'processing' }),
    ]);

    const onDisk = readIndexFile();
    const inMemory = await clipStore.list();
    expect(onDisk).toEqual(inMemory);
    // Both mutations survived rather than one clobbering the other.
    expect(inMemory[0].name).toBe('renamed');
    expect(inMemory[0].captionState).toBe('processing');
  });

  it('always leaves an index on disk, even mid-flight', async () => {
    // The old failure mode was worse than a lost write: the live index was
    // moved to the backup and the replacement move then rejected, so the
    // library had no index at all until the next successful persist.
    await clipStore.add(makeClip('a'));
    const writes = Promise.all([
      clipStore.add(makeClip('b')),
      clipStore.add(makeClip('c')),
    ]);
    await yieldTurn();
    await writes;
    expect(mockFiles.has(INDEX)).toBe(true);
  });

  it('shares one disk read between concurrent first list() calls', async () => {
    mockFiles.set(INDEX, JSON.stringify([makeClip('a')]));
    const RNFS = require('react-native-fs');
    RNFS.readFile.mockClear();

    const [first, second, third] = await Promise.all([
      clipStore.list(),
      clipStore.list(),
      clipStore.list(),
    ]);

    expect(RNFS.readFile).toHaveBeenCalledTimes(1);
    // Same array identity, not merely equal contents: three separate arrays
    // meant a mutation applied to one of them was silently dropped.
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('retries the read after a failed load rather than caching the failure', async () => {
    const RNFS = require('react-native-fs');
    mockFiles.set(INDEX, '{ not json');
    await expect(clipStore.list()).resolves.toEqual([]);

    clipStore.resetCache();
    mockFiles.set(INDEX, JSON.stringify([makeClip('a')]));
    await expect(clipStore.list()).resolves.toHaveLength(1);
    expect(RNFS.readFile).toHaveBeenCalled();
  });
});
