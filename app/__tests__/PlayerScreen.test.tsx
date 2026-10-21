// PlayerScreen hands the audio session to the capture writer while an extended
// recording is still running under the Library.

import type { Clip } from '../src/types';

jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-video', () => {
  const { forwardRef } = require('react');
  return {
    __esModule: true,
    default: forwardRef((props: Record<string, unknown>, _ref: unknown) => {
      mockVideoProps = props;
      return null;
    }),
  };
});
let mockVideoProps: Record<string, unknown> = {};
jest.mock('../src/core/ClipStore', () => ({
  clipStore: {},
  deliverablePath: (clip: Clip) => clip.filePath,
  isCaptioning: () => false,
}));
jest.mock('../src/core/EntitlementStore', () => ({
  entitlementStore: { isPro: async () => false, subscribe: () => () => {} },
}));
jest.mock('../src/phase2/CaptionQueue', () => ({ captionQueue: {} }));
jest.mock('../src/ui/useLiveClip', () => ({ useLiveClip: (clip: Clip) => clip }));
jest.mock('../src/ui/shareClip', () => ({ shareClip: jest.fn() }));

let mockLive = false;
const mockLiveListeners = new Set<(live: boolean) => void>();
jest.mock('../src/services/capture', () => ({
  isAnyCaptureLive: () => mockLive,
  subscribeCaptureLive: (listener: (live: boolean) => void) => {
    mockLiveListeners.add(listener);
    return () => mockLiveListeners.delete(listener);
  },
}));

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { PlayerScreen } from '../src/ui/screens/PlayerScreen';

// The first render loads React Native's lazily required components. On a cold
// transform cache, with suites running in parallel, that alone can outlast
// jest's default 5s, so these render tests get more time.
jest.setTimeout(30_000);

const clip: Clip = {
  id: 'a',
  name: 'a',
  filePath: '/docs/clips/a.mp4',
  thumbnailPath: '/docs/clips/a.jpg',
  capturedAt: 1,
  durationSec: 30,
  sourceKind: 'mwdat',
  savedAt: 1,
  expiresAt: null,
  captionState: 'none',
};

function setLive(live: boolean): void {
  mockLive = live;
  mockLiveListeners.forEach(listener => listener(live));
}

describe('PlayerScreen audio session', () => {
  let renderer: ReactTestRenderer | undefined;

  afterEach(async () => {
    if (renderer) {
      const r = renderer;
      await act(async () => r.unmount());
    }
    mockLive = false;
  });

  it('leaves the session to the capture writer only while capture is live', async () => {
    mockLive = true;
    await act(async () => {
      renderer = create(
        <PlayerScreen route={{ params: { clip } } as any} navigation={{} as any} />,
      );
    });
    expect(mockVideoProps.disableAudioSessionManagement).toBe(true);

    // The recording stops while the clip is open: playback manages it again.
    await act(async () => setLive(false));
    expect(mockVideoProps.disableAudioSessionManagement).toBe(false);
  });
});
