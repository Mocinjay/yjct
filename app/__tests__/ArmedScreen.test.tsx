// ArmedScreen's arm/recovery/Live Activity wiring, against a fake capture
// controller that reports states the way CaptureController does: a failed arm
// goes 'arming' -> 'idle' (its own disarm) -> 'error' and then rejects; a
// stream error mid-session keeps the status and only flips the state.

import type { CaptureStatus } from '../src/core/CaptureController';

let mockFocused = true;
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => mockFocused,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../src/device/glassesLease', () => ({ useGlassesLease: () => {} }));
jest.mock('../src/ui/GlassesPreview', () => ({ GlassesPreview: () => null }));
jest.mock('../src/ui/components', () => ({ RecDot: () => null }));

const mockLiveActivity = {
  start: jest.fn<Promise<boolean>, [string]>(async () => true),
  update: jest.fn(async () => true),
  end: jest.fn(async () => true),
};
jest.mock('../src/native/LiveActivity', () => ({
  LiveActivity: {
    start: (name: string) => mockLiveActivity.start(name),
    update: () => mockLiveActivity.update(),
    end: () => mockLiveActivity.end(),
  },
}));

type Status = Omit<CaptureStatus, 'bufferedAsOf'>;
const mockListeners = new Set<(s: CaptureStatus) => void>();
let mockStatus: CaptureStatus = {
  state: 'idle',
  bufferedSeconds: 0,
  bufferedAsOf: 0,
};
function mockEmit(status: Status): void {
  mockStatus = { ...status, bufferedAsOf: 0 };
  mockListeners.forEach(l => l(mockStatus));
}
const mockArm = jest.fn<Promise<void>, []>();
const mockDisarm = jest.fn(async () => {
  mockEmit({ state: 'idle', bufferedSeconds: 0 });
});
jest.mock('../src/services/capture', () => ({
  buildCaptureSession: async () => ({
    controller: {
      lookBackSeconds: 30,
      subscribe(listener: (s: CaptureStatus) => void) {
        mockListeners.add(listener);
        listener(mockStatus);
        return () => mockListeners.delete(listener);
      },
      arm: () => mockArm(),
      disarm: () => mockDisarm(),
    },
  }),
}));

import React from 'react';
import { AppState } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ArmedScreen } from '../src/ui/screens/ArmedScreen';

/** One native round trip: the arm's prepare() always crosses the bridge. */
const bridgeTick = () => new Promise<void>(resolve => setImmediate(resolve));

async function okArm(): Promise<void> {
  mockEmit({ state: 'arming', bufferedSeconds: 0 });
  await bridgeTick();
  mockEmit({ state: 'armed', bufferedSeconds: 0, armedSince: 1 });
}

async function failingArm(): Promise<void> {
  mockEmit({ state: 'arming', bufferedSeconds: 0 });
  await bridgeTick();
  mockEmit({ state: 'idle', bufferedSeconds: 0 });
  await Promise.resolve();
  mockEmit({ state: 'error', bufferedSeconds: 0, lastError: 'not linked' });
  throw new Error('not linked');
}

const navigation = { canGoBack: () => false, navigate: jest.fn() };

function screen() {
  return <ArmedScreen navigation={navigation as any} route={{} as any} />;
}

async function mount(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(screen());
  });
  await settle();
  return renderer!;
}

/** Lets pending bridge ticks, promise chains and renders run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await bridgeTick();
    });
  }
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await settle();
}

describe('ArmedScreen', () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    mockFocused = true;
    mockListeners.clear();
    mockStatus = { state: 'idle', bufferedSeconds: 0, bufferedAsOf: 0 };
    mockArm.mockReset();
    mockDisarm.mockClear();
    mockLiveActivity.start.mockClear();
    mockLiveActivity.end.mockClear();
    renderer = undefined;
  });

  afterEach(async () => {
    if (renderer) {
      const r = renderer;
      await act(async () => r.unmount());
    }
    jest.useRealTimers();
  });

  it('retries a failed arm only through the bounded, delayed recovery', async () => {
    mockArm.mockImplementation(failingArm);
    renderer = await mount();
    // No immediate retry when the failure re-renders the screen.
    expect(mockArm).toHaveBeenCalledTimes(1);

    await advance(3999);
    expect(mockArm).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mockArm).toHaveBeenCalledTimes(2);

    for (let i = 0; i < 10; i++) {
      await advance(4000);
    }
    // The first arm plus MAX_RECOVERY_ATTEMPTS (3), then it gives up.
    expect(mockArm).toHaveBeenCalledTimes(4);
  });

  it('keeps the Live Activity through a stall recovery that succeeds on a later attempt', async () => {
    mockArm.mockImplementation(okArm);
    renderer = await mount();
    expect(mockLiveActivity.start).toHaveBeenCalledTimes(1);

    // Feed stall: the session carries on in 'error'.
    await act(async () => {
      mockEmit({ ...mockStatus, state: 'error', lastError: 'stalled' });
    });
    mockArm.mockImplementationOnce(failingArm);
    await advance(4000); // attempt 1 fails
    await advance(4000); // attempt 2 succeeds
    expect(mockArm).toHaveBeenCalledTimes(3);
    expect(mockStatus.state).toBe('armed');

    // A second start() would come from the background and be refused, so the
    // activity must never have been ended and restarted.
    expect(mockLiveActivity.end).not.toHaveBeenCalled();
    expect(mockLiveActivity.start).toHaveBeenCalledTimes(1);
  });

  it('ends the Live Activity once recovery gives up', async () => {
    mockArm.mockImplementation(okArm);
    renderer = await mount();
    await act(async () => {
      mockEmit({ ...mockStatus, state: 'error', lastError: 'stalled' });
    });
    mockArm.mockImplementation(failingArm);

    await advance(4000);
    await advance(4000);
    expect(mockLiveActivity.end).not.toHaveBeenCalled();
    await advance(4000); // the last attempt fails
    expect(mockLiveActivity.end).toHaveBeenCalledTimes(1);
    expect(mockArm).toHaveBeenCalledTimes(4);
  });

  it('re-arms on returning to the foreground only when capture is down', async () => {
    let onAppState: (state: string) => void = () => {};
    (AppState.addEventListener as jest.Mock).mockImplementation(
      (_type: string, handler: (state: string) => void) => {
        onAppState = handler;
        return { remove: jest.fn() };
      },
    );
    mockArm.mockImplementation(okArm);
    renderer = await mount();
    expect(mockArm).toHaveBeenCalledTimes(1);

    // A "Clipso" said with the phone pocketed is still stitching.
    await act(async () => {
      mockEmit({ ...mockStatus, state: 'saving' });
    });
    await act(async () => onAppState('active'));
    await settle();
    expect(mockArm).toHaveBeenCalledTimes(1);

    await act(async () => {
      mockEmit({ ...mockStatus, state: 'error', lastError: 'stalled' });
    });
    await act(async () => onAppState('active'));
    await settle();
    expect(mockArm).toHaveBeenCalledTimes(2);
  });

  it('disarms on blur only once a recording ends, and re-arms on refocus', async () => {
    mockArm.mockImplementation(okArm);
    renderer = await mount();
    const r = renderer;
    expect(mockArm).toHaveBeenCalledTimes(1);

    await act(async () => {
      mockEmit({ ...mockStatus, state: 'recording', recordingSince: 5 });
    });
    mockFocused = false;
    await act(async () => r.update(screen()));
    await settle();
    expect(mockDisarm).not.toHaveBeenCalled();

    await act(async () => {
      mockEmit({ ...mockStatus, state: 'armed', recordingSince: undefined });
    });
    await settle();
    expect(mockDisarm).toHaveBeenCalled();

    mockFocused = true;
    await act(async () => r.update(screen()));
    await settle();
    expect(mockArm).toHaveBeenCalledTimes(2);
  });
});
