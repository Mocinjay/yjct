import { NativeModules } from 'react-native';
import { GlassesImportController } from '../src/markers/GlassesImportController';
import { MarkerStore } from '../src/markers/MarkerStore';
import type { WakeWordProvider } from '../src/wakeword/WakeWordProvider';

// `start()` builds a NativeEventEmitter over the real `NativeModules` lookup,
// which the jest preset leaves empty. Mocking the bridge module above replaces
// the promise-returning methods, not the module's presence on NativeModules,
// and NativeEventEmitter refuses a null argument outright.
NativeModules.GlassesMediaLibrary = {
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};

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

/**
 * Yesterday, not a fixed date.
 *
 * `MarkerStore` drops markers older than its 30-day retention, so an absolute
 * fixture quietly stops being importable 30 days after it is written: every
 * marker here ages past the cutoff, `runSync` sees an empty list and returns
 * before it ever confirms a video. That is exactly what happened — this suite
 * was pinned to 2026-08-05 and began failing on 2026-09-04 with no code change
 * behind it, which reads like a broken import pipeline and is not one.
 *
 * Anchored to `Date.now()` so the fixture stays inside retention forever. The
 * offsets below are all relative to it, so the assertions are unaffected.
 */
const RECORDING_START = Date.now() - 24 * 60 * 60 * 1000;

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

function stubWakeWord(): WakeWordProvider {
  return {
    name: 'stub',
    start: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
  };
}

function controller(markerStore: MarkerStore, wakeWord = stubWakeWord()) {
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


/**
 * Standing the microphone down without standing the import down.
 *
 * The two halves of this controller have completely different lifetimes. The
 * microphone is contended — the live-capture path needs the same audio session
 * — but the library watcher and the pending markers are not, and they are the
 * half that has to survive, because a marker written this morning is matched
 * against a recording Meta AI syncs this afternoon. Suspending the whole
 * controller to free a microphone would strand every marker already waiting.
 */
describe('GlassesImportController listening', () => {
  it('starts out listening and watching together', async () => {
    const wakeWord = stubWakeWord();
    const subject = controller(await emptyStore(), wakeWord);

    await subject.start();

    expect(subject.isListening).toBe(true);
    expect(wakeWord.start).toHaveBeenCalledTimes(1);
  });

  it('closes the microphone but keeps watching the library', async () => {
    const wakeWord = stubWakeWord();
    const subject = controller(await emptyStore(), wakeWord);
    await subject.start();

    await subject.suspendListening();

    expect(subject.isListening).toBe(false);
    expect(wakeWord.stop).toHaveBeenCalledTimes(1);
    // The observer is what makes a synced recording turn up on its own, and
    // it costs no microphone at all.
    const { GlassesMediaLibraryNative } = jest.requireMock(
      '../src/native/GlassesMediaLibraryNative',
    );
    expect(GlassesMediaLibraryNative.stopWatching).not.toHaveBeenCalled();
  });

  it('imports while suspended, because that is the half that still works', async () => {
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
    const subject = controller(store);
    await subject.start();
    await subject.suspendListening();

    const clips = await subject.sync();

    expect(clips).toHaveLength(1);
  });

  it('reopens the microphone on resume', async () => {
    const wakeWord = stubWakeWord();
    const subject = controller(await emptyStore(), wakeWord);
    await subject.start();
    await subject.suspendListening();

    await subject.resumeListening();

    expect(subject.isListening).toBe(true);
    expect(wakeWord.start).toHaveBeenCalledTimes(2);
  });

  it('ignores a resume that nothing suspended, and a suspend twice over', async () => {
    const wakeWord = stubWakeWord();
    const subject = controller(await emptyStore(), wakeWord);
    await subject.start();

    await subject.resumeListening();
    await subject.suspendListening();
    await subject.suspendListening();

    expect(wakeWord.start).toHaveBeenCalledTimes(1);
    expect(wakeWord.stop).toHaveBeenCalledTimes(1);
  });

  it('can be resumed after a stop that would not close cleanly', async () => {
    const wakeWord = stubWakeWord();
    (wakeWord.stop as jest.Mock).mockRejectedValueOnce(
      new Error('recognizer would not stop'),
    );
    const subject = controller(await emptyStore(), wakeWord);
    await subject.start();

    await subject.suspendListening();
    await subject.resumeListening();

    // A `listening` flag left true by the failed stop would have made this
    // resume a no-op and killed the trigger for the rest of the session.
    expect(subject.isListening).toBe(true);
    expect(wakeWord.start).toHaveBeenCalledTimes(2);
  });

  it('can start watching without ever opening the microphone', async () => {
    const wakeWord = stubWakeWord();
    const subject = controller(await emptyStore(), wakeWord);

    await subject.start({ listen: false });

    // The case is a service starting while the live-capture path is already
    // armed. Opening the microphone and being told to close it a moment later
    // would reconfigure the audio session under a live capture for nothing.
    expect(wakeWord.start).not.toHaveBeenCalled();
    expect(subject.isListening).toBe(false);
    const { GlassesMediaLibraryNative } = jest.requireMock(
      '../src/native/GlassesMediaLibraryNative',
    );
    expect(GlassesMediaLibraryNative.startWatching).toHaveBeenCalledTimes(1);
  });

  it('opens the microphone on the first resume after a silent start', async () => {
    const wakeWord = stubWakeWord();
    const subject = controller(await emptyStore(), wakeWord);
    await subject.start({ listen: false });

    await subject.resumeListening();

    expect(wakeWord.start).toHaveBeenCalledTimes(1);
    expect(subject.isListening).toBe(true);
  });

  it('does nothing on either call before start', async () => {
    const wakeWord = stubWakeWord();
    const subject = controller(await emptyStore(), wakeWord);

    await subject.suspendListening();
    await subject.resumeListening();

    expect(wakeWord.start).not.toHaveBeenCalled();
    expect(wakeWord.stop).not.toHaveBeenCalled();
  });
});
