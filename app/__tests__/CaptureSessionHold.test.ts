// Captioning is held while any capture session may be recording. A screen that
// is replaced disarms asynchronously, so the hold must follow every live
// session, not whichever reported last.

const mockStopGates: Array<() => void> = [];

jest.mock('../src/core/SettingsStore', () => ({
  settingsStore: {
    get: jest.fn(async () => ({
      bufferSeconds: 30,
      wakeWord: { provider: 'mock' },
      glassesChime: false,
    })),
  },
}));
jest.mock('../src/core/EntitlementStore', () => ({
  entitlementStore: { isPro: jest.fn(async () => true) },
}));
jest.mock('../src/wakeword/SpeechWakeWord', () => ({ SpeechWakeWord: class {} }));
jest.mock('../src/device/MWDATSource', () => ({
  MWDATSource: function MWDATSource() {
    return {
      kind: 'mwdat',
      prepare: async () => {},
      start: async () => {},
      cut: async () => {},
      // stopRecording is a native round trip: held open until released.
      stop: () => new Promise<void>(resolve => mockStopGates.push(() => resolve())),
    };
  },
}));
const mockSetCaptureActive = jest.fn();
jest.mock('../src/phase2/CaptionQueue', () => ({
  captionQueue: {
    setCaptureActive: (active: boolean) => mockSetCaptureActive(active),
    enqueue: jest.fn(async () => {}),
  },
}));
jest.mock('react-native-fs', () => ({ unlink: jest.fn(async () => {}) }));
jest.mock('../src/native/ClipStitcher', () => ({ stitchSegments: jest.fn() }));

import {
  buildCaptureSession,
  isAnyCaptureLive,
  subscribeCaptureLive,
} from '../src/services/capture';

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function releaseStops(): void {
  mockStopGates.splice(0).forEach(release => release());
}

/** Disarms with the native stop answered straight away. */
async function disarmNow(session: { controller: { disarm(): Promise<void> } }) {
  const done = session.controller.disarm();
  await settle();
  releaseStops();
  await done;
}

describe('caption hold across capture sessions', () => {
  beforeEach(() => {
    mockSetCaptureActive.mockClear();
    mockStopGates.length = 0;
  });

  it('a replaced session disarming late does not release the hold over a live one', async () => {
    const old = await buildCaptureSession();
    await old.controller.arm();
    // Library "Go live" resets to a new Armed: the old screen unmounts and
    // disarms while the new one mounts and arms.
    const disarming = old.controller.disarm();
    const fresh = await buildCaptureSession();
    await fresh.controller.arm();
    expect(mockSetCaptureActive).toHaveBeenLastCalledWith(true);

    releaseStops(); // the old stopRecording finally answers
    await disarming;
    await settle();

    // The new session is armed, so captioning must still be held.
    expect(mockSetCaptureActive).toHaveBeenLastCalledWith(true);

    await disarmNow(fresh);
    expect(mockSetCaptureActive).toHaveBeenLastCalledWith(false);
  });

  it('building a new session does not release the hold while the old one is still live', async () => {
    const old = await buildCaptureSession();
    await old.controller.arm();

    // A new screen's session reports 'idle' as soon as it is built.
    const fresh = await buildCaptureSession();
    expect(mockSetCaptureActive).toHaveBeenLastCalledWith(true);

    await disarmNow(old);
    expect(mockSetCaptureActive).toHaveBeenLastCalledWith(false);
    await disarmNow(fresh);
  });
});

describe('capture-live signal', () => {
  beforeEach(() => {
    mockStopGates.length = 0;
  });

  it('reports when any session goes live and when the last one stops', async () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeCaptureLive(live => seen.push(live));
    const a = await buildCaptureSession();
    const b = await buildCaptureSession();
    expect(isAnyCaptureLive()).toBe(false);

    await a.controller.arm();
    await b.controller.arm();
    expect(isAnyCaptureLive()).toBe(true);
    await disarmNow(a);
    // b is still live: no change reported.
    expect(seen).toEqual([true]);

    await disarmNow(b);
    expect(isAnyCaptureLive()).toBe(false);
    expect(seen).toEqual([true, false]);
    unsubscribe();
  });
});
