import type { Clip } from '../../types';
import type { CaptioningProvider } from '../CaptioningProvider';
import type { PublishableClip, PublishTarget } from '../PublishTarget';

const mockFiles = new Map<string, string>();

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
    if (!mockFiles.has(p)) {
      throw new Error('ENOENT');
    }
    mockFiles.delete(p);
  }),
  uploadFiles: jest.fn(() => ({ promise: Promise.resolve({ statusCode: 200, body: '' }) })),
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

/** Records every render; writes the captioned file like a real provider. */
class FakeCaptioner implements CaptioningProvider {
  name = 'on-device';
  calls: string[] = [];
  failWith: string | null = null;

  async caption(clipFilePath: string, options?: { style?: string }) {
    this.calls.push(clipFilePath);
    await Promise.resolve();
    if (this.failWith) {
      throw new Error(this.failWith);
    }
    const captionedFilePath = clipFilePath.replace(
      /\.mp4$/,
      `.captioned.${options?.style ?? 'classic'}.mp4`,
    );
    mockFiles.set(captionedFilePath, 'burned');
    return { captionedFilePath };
  }
}

const mockCaptioner = new FakeCaptioner();

jest.mock('../captioner', () => ({
  getCaptioner: async () => mockCaptioner,
}));

import { clipStore } from '../../core/ClipStore';
import { entitlementStore } from '../../core/EntitlementStore';
import { settingsStore } from '../../core/SettingsStore';
import { captionQueue } from '../CaptionQueue';
import { connectorConfigStore } from '../ConnectorConfig';
import { publishService } from '../PublishService';
import { FacebookPublishTarget } from '../targets/FacebookPublishTarget';
import { TikTokPublishTarget } from '../targets/TikTokPublishTarget';
import { YouTubePublishTarget } from '../targets/YouTubePublishTarget';

const INDEX = '/docs/clips/index.json';
const fetchMock = jest.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

function makeClip(id: string, over: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    filePath: `/docs/clips/${id}.mp4`,
    thumbnailPath: `/docs/clips/${id}.jpg`,
    capturedAt: 1_000_000,
    durationSec: 30,
    sourceKind: 'mwdat',
    savedAt: 1_000_000,
    expiresAt: null,
    captionState: 'none',
    ...over,
  };
}

function seed(clips: Clip[]): void {
  mockFiles.clear();
  mockFiles.set(INDEX, JSON.stringify(clips));
  for (const c of clips) {
    mockFiles.set(c.filePath, 'video');
  }
  clipStore.resetCache();
}

async function clipById(id: string): Promise<Clip | undefined> {
  return (await clipStore.list()).find(c => c.id === id);
}

/** A platform that records what it was handed. */
function fakeTarget(
  over: Partial<Pick<PublishTarget, 'platform' | 'displayName' | 'requiresHostedUrl'>> = {},
) {
  const published: PublishableClip[] = [];
  const target: PublishTarget = {
    platform: 'youtube',
    displayName: 'Fake',
    requiresHostedUrl: false,
    ...over,
    isConfigured: async () => true,
    authenticate: async () => {},
    uploadAndPublish: async clip => {
      published.push(clip);
      return { publishId: 'p1' };
    },
    checkStatus: async () => ({ state: 'published' }),
  };
  return { target, published };
}

const OPTIONS = { caption: 'hi', privacy: 'public' as const, withCaptions: true };

/** Answers the next fetch with this JSON body. */
function respond(json: unknown, ok = true): void {
  fetchMock.mockResolvedValueOnce({
    ok,
    status: ok ? 200 : 400,
    json: async () => json,
  });
}

beforeEach(async () => {
  mockCaptioner.calls = [];
  mockCaptioner.failWith = null;
  fetchMock.mockReset();
  await entitlementStore.devUnlock();
  await settingsStore.update({ captionStyle: 'classic' });
  await connectorConfigStore.update({ hostingPresignUrl: undefined });
});

describe('publishing with captions', () => {
  it('publishes the cut the caption queue renders, recorded on the clip', async () => {
    seed([makeClip('a')]);
    const { target, published } = fakeTarget();

    await publishService.publish((await clipById('a'))!, target, OPTIONS);

    expect(published[0].localFilePath).toBe('/docs/clips/a.captioned.classic.mp4');
    // Recorded, so it is reused next time and deleted with the clip.
    const clip = await clipById('a');
    expect(clip?.captionState).toBe('ready');
    expect(clip?.captionedFilePath).toBe('/docs/clips/a.captioned.classic.mp4');
  });

  it('does not render a second time while the auto-caption job is queued', async () => {
    seed([makeClip('a')]);
    const { target, published } = fakeTarget();
    const opened = (await clipById('a'))!;

    await captionQueue.enqueue('a');
    await publishService.publish(opened, target, OPTIONS);

    expect(mockCaptioner.calls).toHaveLength(1);
    expect(published[0].localFilePath).toBe('/docs/clips/a.captioned.classic.mp4');
  });

  it('reuses a finished captioned cut', async () => {
    seed([
      makeClip('a', {
        captionState: 'ready',
        captionedFilePath: '/docs/clips/a.captioned.boxed.mp4',
        captionProvider: 'on-device',
      }),
    ]);
    const { target, published } = fakeTarget();

    await publishService.publish((await clipById('a'))!, target, OPTIONS);

    expect(mockCaptioner.calls).toHaveLength(0);
    expect(published[0].localFilePath).toBe('/docs/clips/a.captioned.boxed.mp4');
  });

  it('publishes the raw capture when captions are off', async () => {
    seed([makeClip('a')]);
    const { target, published } = fakeTarget();

    await publishService.publish((await clipById('a'))!, target, {
      ...OPTIONS,
      withCaptions: false,
    });

    expect(mockCaptioner.calls).toHaveLength(0);
    expect(published[0].localFilePath).toBe('/docs/clips/a.mp4');
  });

  it("fails with the captioner's reason and publishes nothing", async () => {
    seed([makeClip('a')]);
    mockCaptioner.failWith = 'Speech recognition is not authorised';
    const { target, published } = fakeTarget();

    await expect(
      publishService.publish((await clipById('a'))!, target, OPTIONS),
    ).rejects.toThrow('Speech recognition is not authorised');
    expect(published).toHaveLength(0);
  });
});

describe('hosting', () => {
  it('refuses a URL-pulling platform with no presign endpoint, before captioning', async () => {
    seed([makeClip('a')]);
    const { target, published } = fakeTarget({
      platform: 'instagram',
      displayName: 'Instagram',
      requiresHostedUrl: true,
    });

    await expect(
      publishService.publish((await clipById('a'))!, target, OPTIONS),
    ).rejects.toThrow(/Instagram needs the clip at a public URL/);
    expect(mockCaptioner.calls).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it('gives the dev mock platform fake hosting when none is set', async () => {
    seed([makeClip('a')]);
    const { target, published } = fakeTarget({
      platform: 'mock',
      requiresHostedUrl: true,
    });
    const clip = (await clipById('a'))!;
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const publishing = publishService.publish(clip, target, {
        ...OPTIONS,
        withCaptions: false,
      });
      // MockClipHosting pretends to upload for 600 ms.
      await jest.advanceTimersByTimeAsync(1000);
      await publishing;
    } finally {
      jest.useRealTimers();
    }

    expect(published[0].hostedUrl).toBe('https://cdn.fadeaway.invalid/a.mp4');
  });

  it('uploads through the presign endpoint when one is set', async () => {
    seed([makeClip('a')]);
    await connectorConfigStore.update({ hostingPresignUrl: 'https://host/presign' });
    respond({ uploadUrl: 'https://bucket/put', publicUrl: 'https://cdn/a.mp4' });
    const { target, published } = fakeTarget({
      platform: 'mock',
      requiresHostedUrl: true,
    });

    await publishService.publish((await clipById('a'))!, target, {
      ...OPTIONS,
      withCaptions: false,
    });

    expect(fetchMock).toHaveBeenCalledWith('https://host/presign', expect.anything());
    expect(published[0].hostedUrl).toBe('https://cdn/a.mp4');
  });
});

describe('listTargets', () => {
  const dev = __DEV__;

  afterEach(() => {
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = dev;
  });

  it('offers the always-ready mock platform in dev builds only', async () => {
    const platforms = async () => (await publishService.listTargets()).map(t => t.platform);

    expect(await platforms()).toContain('mock');

    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
    expect(await platforms()).toEqual(['youtube', 'instagram', 'facebook', 'tiktok']);
  });
});

describe('Facebook status', () => {
  const facebook = new FacebookPublishTarget({ pageId: 'page', pageAccessToken: 'token' });

  it.each([
    ['ready', 'published', undefined],
    ['processing', 'processing', undefined],
    ['error', 'failed', 'Facebook could not process the video.'],
    ['expired', 'failed', 'Facebook expired the upload before it was processed.'],
  ])('maps video_status %s to %s', async (videoStatus, state, error) => {
    respond({ status: { video_status: videoStatus }, published: true });

    const status = await facebook.checkStatus('v1');

    expect(status.state).toBe(state);
    expect(status.error).toBe(error);
  });

  it('reports the visibility the Page actually gave the video', async () => {
    respond({ status: { video_status: 'ready' }, published: true });
    expect((await facebook.checkStatus('v1')).actualPrivacy).toBe('public');

    respond({ status: { video_status: 'ready' }, published: false });
    expect((await facebook.checkStatus('v1')).actualPrivacy).toBe('private');

    // Not returned: unknown, rather than a guess that could contradict the
    // privacy the user asked for.
    respond({ status: { video_status: 'ready' } });
    expect((await facebook.checkStatus('v1')).actualPrivacy).toBeUndefined();
  });
});

describe('TikTok privacy', () => {
  async function requestedPrivacy(auditCleared: boolean): Promise<string> {
    respond({ error: { code: 'ok' }, data: { publish_id: 'x' } });
    const tiktok = new TikTokPublishTarget({ accessToken: 't', auditCleared });
    await tiktok.uploadAndPublish(
      { localFilePath: '/a.mp4', hostedUrl: 'https://cdn/a.mp4', title: 'a' },
      '',
      'public',
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    return body.post_info.privacy_level;
  }

  it('asks for self-only until the audit clears, whatever was requested', async () => {
    expect(await requestedPrivacy(false)).toBe('SELF_ONLY');
  });

  it('asks for the requested privacy once the audit has cleared', async () => {
    expect(await requestedPrivacy(true)).toBe('PUBLIC_TO_EVERYONE');
  });
});

describe('YouTube status', () => {
  const youtube = new YouTubePublishTarget({
    getAccessToken: async () => 'token',
    signIn: async () => {},
    isSignedIn: async () => true,
  });

  it.each([
    ['processing', 'processing'],
    ['succeeded', 'published'],
    ['failed', 'failed'],
    ['terminated', 'failed'],
  ])('maps processingStatus %s to %s', async (processingStatus, state) => {
    respond({
      items: [{ status: { privacyStatus: 'public' }, processingDetails: { processingStatus } }],
    });

    expect((await youtube.checkStatus('v1')).state).toBe(state);
  });
});
