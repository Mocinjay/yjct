// The full-resolution import against a real ClipStore and MarkerStore, with
// the photo library, the cutter and the filesystem faked.

import { NativeModules } from 'react-native';

const mockFiles = new Map<string, string>();
const mockListRecentVideos = jest.fn();
const mockConfirmGlassesVideo = jest.fn();
const mockExportOriginal = jest.fn();
const mockExtractRange = jest.fn();

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
    if (!mockFiles.delete(p)) {
      throw new Error('ENOENT');
    }
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

jest.mock('../src/native/ClipStitcher', () => ({
  extractRange: (...args: unknown[]) => mockExtractRange(...args),
  stitchSegments: jest.fn(),
}));

jest.mock('../src/native/GlassesMediaLibraryNative', () => ({
  GLASSES_LIBRARY_CHANGED_EVENT: 'GlassesMediaLibraryChanged',
  glassesLibraryAvailable: () => true,
  GlassesMediaLibraryNative: {
    listRecentVideos: (...a: unknown[]) => mockListRecentVideos(...a),
    confirmGlassesVideo: (...a: unknown[]) => mockConfirmGlassesVideo(...a),
    exportOriginal: (...a: unknown[]) => mockExportOriginal(...a),
    startWatching: jest.fn(async () => true),
    stopWatching: jest.fn(async () => true),
    log: jest.fn(),
  },
}));

jest.mock('../src/native/MWDATNative', () => ({
  MWDATNative: { getStreamTimeline: jest.fn(async () => ({ entries: [] })) },
}));

// NativeEventEmitter needs the module present on NativeModules.
NativeModules.GlassesMediaLibrary = { addListener: jest.fn(), removeListeners: jest.fn() };

import { clipStore } from '../src/core/ClipStore';
import { entitlementStore } from '../src/core/EntitlementStore';
import { GlassesImportController } from '../src/markers/GlassesImportController';
import { MarkerStore } from '../src/markers/MarkerStore';
import type { WakeMarker } from '../src/markers/markerMatching';
import type { Clip } from '../src/types';

/** Yesterday, so markers stay inside the store's 30-day retention. */
const RECORDING_START = Date.now() - 24 * 60 * 60 * 1000;
const ORIGINAL = '/caches/glasses-1.mov';

const GLASSES_VIDEO = {
  localIdentifier: 'GLASSES-VIDEO',
  startedAtMs: RECORDING_START,
  durationSec: 120,
  width: 1520,
  height: 2032,
};

function confirmAsGlasses(overrides: Record<string, unknown> = {}) {
  mockConfirmGlassesVideo.mockResolvedValue({
    isGlasses: true,
    pendingDownload: false,
    startedAtMs: RECORDING_START,
    durationSec: 120,
    width: 1520,
    height: 2032,
    ...overrides,
  });
}

function proxyClip(id: string, over: Partial<Clip> = {}): Clip {
  return {
    id,
    name: 'Beach',
    filePath: `/docs/clips/${id}.mp4`,
    thumbnailPath: `/docs/clips/${id}.jpg`,
    capturedAt: RECORDING_START + 60_000,
    durationSec: 30,
    sourceKind: 'mwdat',
    quality: 'proxy',
    savedAt: null,
    expiresAt: Date.now() + 3600_000,
    captionState: 'none',
    ...over,
  };
}

/** A marker whose span is `fromSec`…`toSec` into the recording. */
function marker(id: string, toSec: number, extra: Partial<WakeMarker> = {}): WakeMarker {
  return { id, atMs: RECORDING_START + toSec * 1000, ...extra };
}

function at(sec: number): number {
  return RECORDING_START + sec * 1000;
}

let markers: MarkerStore;
let ready: Clip[];

function controller() {
  return new GlassesImportController(markers, {
    lookbackSec: 10,
    coverageToleranceSec: 1.5,
    onClipReady: clip => ready.push(clip),
  });
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockFiles.clear();
  mockFiles.set('/docs/clips/index.json', '[]');
  clipStore.resetCache();
  await entitlementStore.clear();
  markers = new MarkerStore();
  ready = [];
  mockListRecentVideos.mockResolvedValue({ videos: [GLASSES_VIDEO] });
  mockExportOriginal.mockImplementation(async () => {
    mockFiles.set(ORIGINAL, 'master');
    return { path: ORIGINAL, bytes: 90_000_000 };
  });
  mockExtractRange.mockImplementation(
    async (_src: string, start: number, end: number, out: string) => {
      mockFiles.set(out, 'cut');
      return { outputPath: out, thumbnailPath: out.replace('.mp4', '.jpg'), durationSec: end - start };
    },
  );
});

async function seedClips(clips: Clip[]): Promise<void> {
  mockFiles.set('/docs/clips/index.json', JSON.stringify(clips));
  for (const clip of clips) {
    mockFiles.set(clip.filePath, 'proxy');
    mockFiles.set(clip.thumbnailPath, 'jpeg');
  }
  clipStore.resetCache();
}

describe('GlassesImportController.sync', () => {
  it('does nothing at all when no moment was marked', async () => {
    expect(await controller().sync()).toEqual([]);
    expect(mockListRecentVideos).not.toHaveBeenCalled();
  });

  it('never opens or copies a recording no marker points into', async () => {
    await markers.add(marker('m1', 6 * 3600));
    expect(await controller().sync()).toEqual([]);
    expect(mockConfirmGlassesVideo).not.toHaveBeenCalled();
    expect(mockExportOriginal).not.toHaveBeenCalled();
  });

  it('cuts a marked moment out of the glasses recording as a full-resolution clip', async () => {
    await markers.add(marker('m1', 15));
    confirmAsGlasses();

    const [clip] = await controller().sync();

    expect(mockExtractRange).toHaveBeenCalledWith(ORIGINAL, 5, 15, expect.stringContaining('/docs/clips/'));
    expect(clip).toMatchObject({ sourceKind: 'glasses-library', quality: 'master', durationSec: 10 });
    // Free tier: the retention clock starts when the clip lands.
    expect(clip.expiresAt).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(ready.map(c => c.id)).toEqual([clip.id]);
    expect(await clipStore.list()).toHaveLength(1);
    // The copied original is deleted and the marker spent.
    expect(mockFiles.has(ORIGINAL)).toBe(false);
    expect(await markers.all()).toEqual([]);
  });

  it('leaves the markers pending for a recording still in iCloud', async () => {
    await markers.add(marker('m1', 15));
    mockConfirmGlassesVideo.mockResolvedValue({ isGlasses: false, pendingDownload: true });

    expect(await controller().sync()).toEqual([]);
    expect(mockExportOriginal).not.toHaveBeenCalled();
    expect(await markers.all()).toHaveLength(1);
  });

  it('ignores a phone video recorded at the same time', async () => {
    await markers.add(marker('m1', 15));
    mockConfirmGlassesVideo.mockResolvedValue({ isGlasses: false, pendingDownload: false });

    expect(await controller().sync()).toEqual([]);
    expect(mockExportOriginal).not.toHaveBeenCalled();
  });

  it('keeps the markers of a cut that failed for the next pass', async () => {
    await markers.add(marker('m1', 15));
    await markers.add(marker('m2', 100));
    confirmAsGlasses();
    mockExtractRange.mockImplementationOnce(async (_s: string, start: number, end: number, out: string) => {
      mockFiles.set(out, 'cut');
      return { outputPath: out, thumbnailPath: out.replace('.mp4', '.jpg'), durationSec: end - start };
    });
    mockExtractRange.mockImplementationOnce(async () => {
      throw new Error('export failed');
    });

    const clips = await controller().sync();

    expect(clips).toHaveLength(1);
    expect((await markers.all()).map(m => m.id)).toEqual(['m2']);
    expect(mockFiles.has(ORIGINAL)).toBe(false);
  });

  it('runs once more for a marker recorded while a pass was running', async () => {
    await markers.add(marker('m1', 15));
    confirmAsGlasses();
    let releaseListing: () => void = () => {};
    mockListRecentVideos.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseListing = () => resolve({ videos: [GLASSES_VIDEO] });
        }),
    );
    const c = controller();

    const first = c.sync();
    await new Promise<void>(resolve => setImmediate(resolve));
    await markers.add(marker('m2', 100));
    const second = c.sync();
    releaseListing();

    expect(await second).toBe(await first);
    expect((await first).length).toBe(2);
    expect(await markers.all()).toEqual([]);
  });
});

describe('upgrading a 720p clip', () => {
  it('replaces the clip in place when the recording covers its span', async () => {
    await seedClips([proxyClip('clip_a', { captionState: 'ready', captionedFilePath: '/docs/clips/clip_a.captioned.classic.mp4' })]);
    await markers.add(marker('p1', 60, { startMs: at(30), proxyClipId: 'clip_a' }));
    confirmAsGlasses();

    const [clip] = await controller().sync();

    expect(mockExtractRange).toHaveBeenCalledWith(ORIGINAL, 30, 60, expect.any(String));
    const library = await clipStore.list();
    expect(library).toHaveLength(1);
    expect(library[0]).toMatchObject({
      id: 'clip_a',
      name: 'Beach',
      quality: 'master',
      sourceKind: 'glasses-library',
      captionState: 'none',
    });
    expect(clip.id).toBe('clip_a');
    // Re-captioned from the new file.
    expect(ready.map(c => c.id)).toEqual(['clip_a']);
    expect(mockFiles.has('/docs/clips/clip_a.mp4')).toBe(false);
  });

  it('keeps the 720p clip and adds the cut beside it when the recording started too late', async () => {
    await seedClips([proxyClip('clip_a')]);
    // The 720p clip starts 20 s before the glasses began recording.
    await markers.add(marker('p1', 40, { startMs: at(-20), proxyClipId: 'clip_a' }));
    confirmAsGlasses();

    const [clip] = await controller().sync();

    const library = await clipStore.list();
    expect(library.map(c => c.id).sort()).toEqual([clip.id, 'clip_a'].sort());
    expect(library.find(c => c.id === 'clip_a')?.quality).toBe('proxy');
    expect(clip.name).toMatch(/· full res$/);
    expect(clip.quality).toBe('master');
  });

  it('adds the cut as its own clip when the 720p clip is already gone', async () => {
    await markers.add(marker('p1', 60, { startMs: at(30), proxyClipId: 'clip_gone' }));
    confirmAsGlasses();

    const [clip] = await controller().sync();

    expect(clip.id).not.toBe('clip_gone');
    expect(clip.name).not.toMatch(/full res/);
    expect(await clipStore.list()).toHaveLength(1);
  });
});
