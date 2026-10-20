const mockFiles = new Map<string, string>();

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  MainBundlePath: '/bundle',
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
  copyFile: jest.fn(async (from: string, to: string) => {
    mockFiles.set(to, mockFiles.get(from) ?? '');
  }),
  moveFile: jest.fn(async (from: string, to: string) => {
    mockFiles.set(to, mockFiles.get(from) ?? '');
    mockFiles.delete(from);
  }),
  unlink: jest.fn(async (p: string) => {
    if (!mockFiles.has(p)) {
      throw new Error('ENOENT');
    }
    mockFiles.delete(p);
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
    },
  };
});

/** The on-device engines, driven per test. */
const mockEngine = {
  renderFails: false,
  analysisFails: false,
};

jest.mock('../../native/CaptionEngineNative', () => ({
  climaxEngineAvailable: () => true,
  transcribeClip: async () => ({ words: [] }),
  extractFeatures: async () => {
    if (mockEngine.analysisFails) {
      throw new Error('no audio track');
    }
    return {
      hop: 1,
      times: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      duration: 10,
      signals: { 'visual.frame_diff': [0, 0, 1, 5, 9, 4, 1, 0, 0, 0] },
    };
  },
  renderEdit: async (_source: string, outputPath: string) => {
    if (mockEngine.renderFails) {
      throw new Error('export failed');
    }
    mockFiles.set(outputPath, 'rendered');
    return { outputPath, durationSec: 10, cues: 0 };
  },
}));

import { clipStore } from '../../core/ClipStore';
import { settingsStore } from '../../core/SettingsStore';
import { runTestRender } from '../testRender';

/** Every .mp4 left in the clips folder. */
function videosOnDisk(): string[] {
  return [...mockFiles.keys()].filter(p => p.endsWith('.mp4') && p.startsWith('/docs/'));
}

beforeEach(async () => {
  mockFiles.clear();
  mockFiles.set('/bundle/MockFeed.mp4', 'sample');
  clipStore.resetCache();
  mockEngine.renderFails = false;
  mockEngine.analysisFails = false;
  await settingsStore.update({ climaxEdit: false });
});

describe('dev test render', () => {
  it('leaves only the render on disk, not its working copy', async () => {
    await runTestRender();

    const [clip] = await clipStore.list();
    expect(videosOnDisk()).toEqual([clip.filePath]);
    expect(clip.filePath).toMatch(/\.rendered\.mp4$/);
  });

  it('removes the working copy when the render fails', async () => {
    mockEngine.renderFails = true;

    await expect(runTestRender()).rejects.toThrow('export failed');

    expect(videosOnDisk()).toEqual([]);
    expect(await clipStore.list()).toEqual([]);
  });

  it('falls back to chronological captions when the analysis fails, as the captioner does', async () => {
    await settingsStore.update({ climaxEdit: true });
    mockEngine.analysisFails = true;

    const { lines } = await runTestRender();

    const [clip] = await clipStore.list();
    // Labelled by what ran, not by the setting.
    expect(clip.captionProvider).toBe('on-device');
    expect(lines).toContain('Analysis failed, captioning chronologically: no audio track');
  });

  it('labels a hook-first render as such', async () => {
    await settingsStore.update({ climaxEdit: true });

    await runTestRender();

    const [clip] = await clipStore.list();
    expect(clip.captionProvider).toBe('on-device+hook');
  });
});
