// PublishScreen's publish flow, against a fake publish service and store.

import type { Clip } from '../src/types';
import type { PublishTarget } from '../src/phase2/PublishTarget';

const mockMarkPublished = jest.fn<Promise<void>, [string, string]>();
jest.mock('../src/core/ClipStore', () => ({
  clipStore: {
    markPublished: (id: string, platform: string) => mockMarkPublished(id, platform),
  },
  hasBurnedCaptions: () => false,
}));
jest.mock('../src/ui/useLiveClip', () => ({ useLiveClip: (clip: Clip) => clip }));

const mockTarget: PublishTarget = {
  platform: 'youtube',
  displayName: 'Fake',
  requiresHostedUrl: false,
  isConfigured: async () => true,
  authenticate: async () => {},
  uploadAndPublish: async () => ({ publishId: 'p1' }),
  checkStatus: async () => ({ state: 'published' }),
};
const mockPublish = jest.fn(async () => ({ publishId: 'p1' }));
jest.mock('../src/phase2/PublishService', () => ({
  publishService: {
    listTargets: async () => [mockTarget],
    publish: () => mockPublish(),
    checkStatus: async () => ({ state: 'published' }),
  },
}));

import React from 'react';
import { Alert, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { PublishScreen } from '../src/ui/screens/PublishScreen';

const clip: Clip = {
  id: 'a',
  name: 'a',
  filePath: '/docs/clips/a.mp4',
  thumbnailPath: '/docs/clips/a.jpg',
  capturedAt: 1,
  durationSec: 30,
  sourceKind: 'mwdat',
  savedAt: null,
  expiresAt: 2,
  captionState: 'none',
};

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
    });
  }
}

function pressText(r: ReactTestRenderer, label: string): void {
  // The nearest ancestor with an onPress is the control the label sits in.
  let node = r.root.find(n => n.type === Text && n.props.children === label).parent;
  while (node && !node.props.onPress) {
    node = node.parent;
  }
  node!.props.onPress();
}

describe('PublishScreen', () => {
  let renderer: ReactTestRenderer | undefined;
  let alertSpy: jest.SpyInstance;

  beforeEach(() => {
    mockPublish.mockClear();
    mockMarkPublished.mockReset();
    // Confirms the consent dialog; records every other alert.
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((title, _msg, buttons) => {
      if (title.startsWith('Publish to')) {
        buttons?.find(b => b.text === 'Publish')?.onPress?.();
      }
    });
  });

  afterEach(async () => {
    alertSpy.mockRestore();
    if (renderer) {
      const r = renderer;
      await act(async () => r.unmount());
    }
  });

  it('does not invite a second publish when only marking the clip kept fails', async () => {
    mockMarkPublished.mockRejectedValue(new Error('disk full'));
    await act(async () => {
      renderer = create(<PublishScreen route={{ params: { clip } } as any} navigation={{} as any} />);
    });
    await settle();
    const r = renderer!;

    await act(async () => pressText(r, 'Fake'));
    await act(async () => pressText(r, 'Publish'));
    await settle();

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockMarkPublished).toHaveBeenCalledWith('a', 'youtube');
    // The status view, not the compose form with a "Publish failed" alert.
    expect(r.root.findByProps({ children: 'Published to Fake' })).toBeTruthy();
    const titles = alertSpy.mock.calls.map(c => c[0]);
    expect(titles).not.toContain('Publish failed');
    expect(titles).toContain('Published, but not kept');
  });
});
