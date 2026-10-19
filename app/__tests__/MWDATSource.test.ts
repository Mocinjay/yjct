type Listener = (event: unknown) => void;

const mockListeners = new Map<string, Set<Listener>>();

jest.mock('../src/native/MWDATNative', () => ({
  mwdatAvailable: () => true,
  mwdatEvents: () => ({
    addListener: (name: string, listener: Listener) => {
      const set = mockListeners.get(name) ?? new Set<Listener>();
      set.add(listener);
      mockListeners.set(name, set);
      return { remove: () => set.delete(listener) };
    },
  }),
  MWDATNative: {
    prepare: jest.fn(async () => {}),
    start: jest.fn(async () => {}),
    stopRecording: jest.fn(async () => {}),
    cut: jest.fn(async () => {}),
    chime: jest.fn(async () => true),
  },
}));

import { MWDATNative } from '../src/native/MWDATNative';
import { MWDATSource } from '../src/device/MWDATSource';

function emit(name: string, event: unknown): void {
  mockListeners.get(name)?.forEach(listener => listener(event));
}

describe('MWDATSource', () => {
  beforeEach(() => {
    mockListeners.clear();
  });

  it('delivers each segment once when re-armed without a stop', async () => {
    const source = new MWDATSource();
    const segments: string[] = [];
    const onSegment = (s: { path: string }) => segments.push(s.path);

    await source.start(onSegment, () => {});
    // The capture screen re-arms from the error state like this: start again,
    // no stop in between.
    await source.start(onSegment, () => {});
    emit('MWDATSegment', { path: '/a.mp4', startedAt: 0, durationSec: 5 });

    expect(segments).toEqual(['/a.mp4']);
  });

  it('stops delivering after stop()', async () => {
    const source = new MWDATSource();
    const segments: string[] = [];
    await source.start(
      s => segments.push(s.path),
      () => {},
    );
    await source.stop();
    emit('MWDATSegment', { path: '/a.mp4', startedAt: 0, durationSec: 5 });

    expect(segments).toEqual([]);
  });

  it('keeps a newer start\'s listeners when a superseded start fails late', async () => {
    const source = new MWDATSource();
    const segments: string[] = [];
    const onSegment = (s: { path: string }) => segments.push(s.path);
    let rejectFirst: (e: Error) => void = () => {};
    (MWDATNative.start as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectFirst = reject;
        }),
    );

    const first = source.start(onSegment, () => {});
    await source.start(onSegment, () => {});
    rejectFirst(new Error('stale open failed'));
    await expect(first).rejects.toThrow('stale open failed');
    emit('MWDATSegment', { path: '/a.mp4', startedAt: 0, durationSec: 5 });

    expect(segments).toEqual(['/a.mp4']);
  });
});
