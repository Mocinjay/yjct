// ConnectScreen's auto-open of the glasses preview and its diagnostics
// polling, against a fake MWDAT bridge.

import type { MWDATDiagnostics } from '../src/native/MWDATNative';

jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('../src/device/glassesLease', () => ({ useGlassesLease: () => {} }));
jest.mock('../src/ui/GlassesPreview', () => ({ GlassesPreview: () => null }));

type Listener = (event: unknown) => void;
const mockListeners = new Map<string, Set<Listener>>();
const mockLink = { linkState: 'connected' };
function mockSnapshot(): MWDATDiagnostics {
  // A fresh object every call, as the native bridge builds one.
  return {
    registration: 'registered',
    devices: [
      {
        name: 'Ray-Ban Meta',
        linkState: mockLink.linkState,
        compatibility: 'compatible',
        type: 'rayBanMeta',
      },
    ],
    streamState: 'none',
    recording: false,
    cameraPermission: 'granted',
  };
}
const mockGetDiagnostics = jest.fn<Promise<MWDATDiagnostics>, []>();
const mockStartPreview = jest.fn<Promise<void>, []>();
jest.mock('../src/native/MWDATNative', () => ({
  mwdatAvailable: () => true,
  mwdatIsSimulator: () => false,
  mwdatEvents: () => ({
    addListener: (name: string, listener: Listener) => {
      const set = mockListeners.get(name) ?? new Set<Listener>();
      set.add(listener);
      mockListeners.set(name, set);
      return { remove: () => set.delete(listener) };
    },
  }),
  MWDATNative: {
    getDiagnostics: () => mockGetDiagnostics(),
    prepare: async () => {},
    startPreview: () => mockStartPreview(),
    startRegistration: async () => 'registered',
    mockEnable: async () => {},
  },
}));

import React from 'react';
import { AppState } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ConnectScreen } from '../src/ui/screens/ConnectScreen';

// The first render loads React Native's lazily required components. On a cold
// transform cache, with suites running in parallel, that alone can outlast
// jest's default 5s, so these render tests get more time.
jest.setTimeout(30_000);

function emit(name: string, event: unknown): void {
  mockListeners.get(name)?.forEach(listener => listener(event));
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  });

describe('ConnectScreen', () => {
  let renderer: ReactTestRenderer | undefined;
  let onAppState: (state: string) => void;
  let appStateSubscriptions: number;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    mockListeners.clear();
    mockLink.linkState = 'connected';
    mockGetDiagnostics.mockReset();
    mockGetDiagnostics.mockImplementation(async () => mockSnapshot());
    mockStartPreview.mockReset();
    mockStartPreview.mockImplementation(async () => {});
    appStateSubscriptions = 0;
    onAppState = () => {};
    (AppState as { currentState: unknown }).currentState = 'active';
    (AppState.addEventListener as jest.Mock).mockImplementation(
      (_type: string, handler: (state: string) => void) => {
        onAppState = handler;
        appStateSubscriptions += 1;
        return { remove: jest.fn() };
      },
    );
  });

  afterEach(async () => {
    if (renderer) {
      const r = renderer;
      await act(async () => r.unmount());
      renderer = undefined;
    }
    jest.useRealTimers();
  });

  async function mount(): Promise<void> {
    await act(async () => {
      renderer = create(
        <ConnectScreen navigation={{ reset: jest.fn() } as any} route={{} as any} />,
      );
    });
    await settle();
  }

  it('does not reopen a feed released in the background until the app returns', async () => {
    await mount();
    expect(mockStartPreview).toHaveBeenCalledTimes(1);

    (AppState as { currentState: unknown }).currentState = 'background';
    await act(async () => {
      emit('MWDATStreamState', { state: 'stopped', reason: 'didEnterBackground' });
    });
    await settle();
    expect(mockStartPreview).toHaveBeenCalledTimes(1);

    (AppState as { currentState: unknown }).currentState = 'active';
    await act(async () => onAppState('active'));
    await settle();
    expect(mockStartPreview).toHaveBeenCalledTimes(2);
  });

  it('retries a failed open on a link change, not on every poll', async () => {
    mockStartPreview.mockRejectedValue(new Error('session start timed out'));
    await mount();
    const subscriptions = appStateSubscriptions;

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      await settle();
    }
    expect(mockGetDiagnostics.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(mockStartPreview).toHaveBeenCalledTimes(1);
    // Unchanged polls do not resubscribe the AppState listener either.
    expect(appStateSubscriptions).toBe(subscriptions);

    mockStartPreview.mockResolvedValue(undefined);
    mockLink.linkState = 'disconnected';
    await act(async () => emit('MWDATDevices', null));
    await settle();
    expect(mockStartPreview).toHaveBeenCalledTimes(2);
  });

  it('runs one getDiagnostics() at a time and answers queued requests with one follow-up', async () => {
    const pending: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    mockGetDiagnostics.mockImplementation(
      () =>
        new Promise(resolve => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          pending.push(() => {
            inFlight -= 1;
            resolve(mockSnapshot());
          });
        }),
    );
    await mount();
    expect(mockGetDiagnostics).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) {
      await act(async () => emit('MWDATDevices', null));
    }
    expect(mockGetDiagnostics).toHaveBeenCalledTimes(1);

    await act(async () => pending.shift()?.());
    await settle();
    expect(mockGetDiagnostics).toHaveBeenCalledTimes(2);

    await act(async () => pending.shift()?.());
    await settle();
    expect(mockGetDiagnostics).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
  });
});
