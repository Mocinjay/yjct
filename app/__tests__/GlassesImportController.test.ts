import { GlassesImportController } from '../src/markers/GlassesImportController';
import { MarkerStore } from '../src/markers/MarkerStore';
import type { WakeWordProvider } from '../src/wakeword/WakeWordProvider';

// Every binding a jest.mock factory touches must be named `mock*` — the
// factories are hoisted above these declarations.
const mockExtractRange = jest.fn();
const mockListRecentVideos = jest.fn();
const mockConfirmGlassesVideo = jest.fn();
const mockExportOriginal = jest.fn();
const mockAdded: { id: string; sourceKind: string; durationSec: number }[] = [];

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
  exists: jest.fn(async () => true),
  unlink: jest.fn(async () => {}),
  readFile: jest.fn(async () => '[]'),
  writeFile: jest.fn(async () => {}),
}));

jest.mock('../src/native/ClipStitcher', () => ({
  extractRange: (...args: unknown[]) => mockExtractRange(...args),
  stitchSegments: jest.fn(),
}));

jest.mock('../src/native/GlassesMediaLibraryNative', () => ({
  GLASSES_LIBRARY_CHANGED_EVENT: 'GlassesMediaLibraryChanged',
  GlassesMediaLibraryNative: {
    requestAccess: jest.fn(async () => ({ status: 'authorized', usable: true })),
    listRecentVideos: (...a: unknown[]) => mockListRecentVideos(...a),
    confirmGlassesVideo: (...a: unknown[]) => mockConfirmGlassesVideo(...a),
    exportOriginal: (...a: unknown[]) => mockExportOriginal(...a),
    startWatching: jest.fn(async () => true),
    stopWatching: jest.fn(async () => true),
  },
}));

// Only the store's disk-backed half is replaced. `newClip`/`newClipId` are
// pure and shared with the capture path, so stubbing them out here would test
// a clip shape this module does not actually produce.
jest.mock('../src/core/ClipStore', () => ({
  ...jest.requireActual('../src/core/ClipStore'),
  clipStore: {
    ensureDir: jest.fn(async () => '/docs/clips'),
    add: jest.fn(async (clip: { id: string; sourceKind: string; durationSec: number }) => {
      mockAdded.push(clip);
    }),
  },
}));

jest.mock('../src/core/EntitlementStore', () => ({
  entitlementStore: { isPro: jest.fn(async () => false) },
}));

const RECORDING_START = Date.parse('2026-08-05T20:36:39Z');

/** A recording that is not the glasses' — someone filming at the same time. */
const OTHER_VIDEO = {
  localIdentifier: 'PHONE-VIDEO',
  startedAtMs: RECORDING_START,
  durationSec: 20,
  width: 1080,
  height: 1920,
};

const GLASSES_VIDEO = {
  localIdentifier: 'GLASSES-VIDEO',
  startedAtMs: RECORDING_START,
  durationSec: 20,
  width: 1520,
  height: 2032,
};

function controller(markerStore: MarkerStore) {
  const wakeWord: WakeWordProvider = {
    name: 'stub',
    start: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
  };
  return new GlassesImportController(markerStore, wakeWord, { lookbackSec: 10 });
}

async function emptyStore(): Promise<MarkerStore> {
  const store = new MarkerStore();
  await store.clear();
  return store;
}

beforeEach(() => {
  mockAdded.length = 0;
  jest.clearAllMocks();
  mockExtractRange.mockImplementation(
    async (_src: string, start: number, end: number, out: string) => ({
      outputPath: out,
      thumbnailPath: out.replace('.mp4', '.jpg'),
      durationSec: end - start,
    }),
  );
});

describe('GlassesImportController.sync', () => {
  it('does nothing at all when no trigger word was ever said', async () => {
    const store = await emptyStore();
    mockListRecentVideos.mockResolvedValue({ videos: [GLASSES_VIDEO] });

    const clips = await controller(store).sync();

    expect(clips).toEqual([]);
    // Not even a listing: with nothing pending there is nothing to look for.
    expect(mockListRecentVideos).not.toHaveBeenCalled();
  });

  it('leaves unmarked footage completely alone — never opened, never copied', async () => {
    const store = await emptyStore();
    // Marker from an entirely different afternoon.
    await store.add({ id: 'm1', atMs: RECORDING_START + 6 * 60 * 60 * 1000 });
    mockListRecentVideos.mockResolvedValue({ videos: [GLASSES_VIDEO] });

    const clips = await controller(store).sync();

    expect(clips).toEqual([]);
    expect(mockConfirmGlassesVideo).not.toHaveBeenCalled();
    expect(mockExportOriginal).not.toHaveBeenCalled();
  });

  it('imports a marked glasses recording and cuts the look-back window', async () => {
    const store = await emptyStore();
    await store.add({ id: 'm1', atMs: RECORDING_START + 15_000 });
    mockListRecentVideos.mockResolvedValue({ videos: [GLASSES_VIDEO] });
    mockConfirmGlassesVideo.mockResolvedValue({
      isGlasses: true,
      pendingDownload: false,
      startedAtMs: RECORDING_START,
      durationSec: 20,
      width: 1520,
      height: 2032,
    });
    mockExportOriginal.mockResolvedValue({
      path: '/docs/glasses-1.mov',
      bytes: 33_000_000,
    });

    const clips = await controller(store).sync();

    expect(clips).toHaveLength(1);
    expect(mockAdded[0].sourceKind).toBe('glasses-library');
    // Ends on the trigger at 15s, looking back 10s.
    expect(mockExtractRange).toHaveBeenCalledWith(
      '/docs/glasses-1.mov',
      5,
      15,
      expect.stringContaining('/docs/clips/'),
    );
  });

  it('opens a marked video but does not copy it when the glasses did not record it', async () => {
    const store = await emptyStore();
    await store.add({ id: 'm1', atMs: RECORDING_START + 15_000 });
    mockListRecentVideos.mockResolvedValue({ videos: [OTHER_VIDEO] });
    mockConfirmGlassesVideo.mockResolvedValue({
      isGlasses: false,
      pendingDownload: false,
    });

    const clips = await controller(store).sync();

    expect(clips).toEqual([]);
    expect(mockConfirmGlassesVideo).toHaveBeenCalledWith('PHONE-VIDEO');
    expect(mockExportOriginal).not.toHaveBeenCalled();
  });

  it('keeps markers pending while the recording is still in iCloud', async () => {
    const store = await emptyStore();
    await store.add({ id: 'm1', atMs: RECORDING_START + 15_000 });
    mockListRecentVideos.mockResolvedValue({ videos: [GLASSES_VIDEO] });
    mockConfirmGlassesVideo.mockResolvedValue({
      isGlasses: false,
      pendingDownload: true,
    });

    const clips = await controller(store).sync();

    expect(clips).toEqual([]);
    expect(mockExportOriginal).not.toHaveBeenCalled();
    // The whole point: the marker survives for the pass after it lands.
    expect(await store.all()).toHaveLength(1);
  });

  it('forgets markers once they became clips, so a second pass re-imports nothing', async () => {
    const store = await emptyStore();
    await store.add({ id: 'm1', atMs: RECORDING_START + 15_000 });
    mockListRecentVideos.mockResolvedValue({ videos: [GLASSES_VIDEO] });
    mockConfirmGlassesVideo.mockResolvedValue({
      isGlasses: true,
      pendingDownload: false,
      startedAtMs: RECORDING_START,
      durationSec: 20,
    });
    mockExportOriginal.mockResolvedValue({ path: '/docs/glasses-1.mov', bytes: 1 });

    const c = controller(store);
    expect(await c.sync()).toHaveLength(1);
    expect(await store.all()).toEqual([]);

    mockExportOriginal.mockClear();
    expect(await c.sync()).toEqual([]);
    expect(mockExportOriginal).not.toHaveBeenCalled();
  });

  it('copies the original once no matter how many moments were marked in it', async () => {
    const store = await emptyStore();
    await store.add({ id: 'm1', atMs: RECORDING_START + 20_000 });
    await store.add({ id: 'm2', atMs: RECORDING_START + 100_000 });
    const long = { ...GLASSES_VIDEO, durationSec: 180 };
    mockListRecentVideos.mockResolvedValue({ videos: [long] });
    mockConfirmGlassesVideo.mockResolvedValue({
      isGlasses: true,
      pendingDownload: false,
      startedAtMs: RECORDING_START,
      durationSec: 180,
    });
    mockExportOriginal.mockResolvedValue({ path: '/docs/glasses-1.mov', bytes: 1 });

    const clips = await controller(store).sync();

    expect(clips).toHaveLength(2);
    expect(mockExportOriginal).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed recording from stranding the others', async () => {
    const store = await emptyStore();
    await store.add({ id: 'm1', atMs: RECORDING_START + 15_000 });
    const second = {
      ...GLASSES_VIDEO,
      localIdentifier: 'GLASSES-VIDEO-2',
      startedAtMs: RECORDING_START + 600_000,
    };
    await store.add({ id: 'm2', atMs: second.startedAtMs + 5_000 });
    mockListRecentVideos.mockResolvedValue({ videos: [GLASSES_VIDEO, second] });
    mockConfirmGlassesVideo
      .mockRejectedValueOnce(new Error('unreadable'))
      .mockResolvedValue({
        isGlasses: true,
        pendingDownload: false,
        startedAtMs: second.startedAtMs,
        durationSec: 20,
      });
    mockExportOriginal.mockResolvedValue({ path: '/docs/glasses-2.mov', bytes: 1 });

    const clips = await controller(store).sync();

    expect(clips).toHaveLength(1);
    // The failed one's marker is kept so the next pass tries it again.
    expect((await store.all()).map(m => m.id)).toEqual(['m1']);
  });
});
