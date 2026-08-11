/**
 * The photo-access gate.
 *
 * "Selected Photos" is the failure this feature is most exposed to, because
 * nothing about it looks like a failure: the permission is granted, the scan
 * runs, and it finds nothing forever. These tests hold the line that the switch
 * cannot be turned on in that state, and that losing access later turns it off
 * rather than leaving the app claiming to be listening.
 */

import { photoAccessBlocker } from '../src/markers/photoAccess';
import type { PhotoAccessStatus } from '../src/native/GlassesMediaLibraryNative';

// Hoisted above the declarations below, so every binding a factory reaches
// must be named `mock*`.
const mockRequestAccess = jest.fn();
const mockCurrentAccess = jest.fn();
const mockStart = jest.fn(async () => {});
const mockStop = jest.fn(async () => {});
const mockSync = jest.fn(async () => []);
const mockAppStateListeners: ((state: string) => void)[] = [];

jest.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
    select: (choices: Record<string, unknown>) => choices.ios ?? choices.default,
  },
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mockAppStateListeners.push(listener);
      return { remove: jest.fn() };
    },
  },
}));

jest.mock('../src/native/GlassesMediaLibraryNative', () => ({
  GLASSES_LIBRARY_CHANGED_EVENT: 'GlassesMediaLibraryChanged',
  GlassesMediaLibraryNative: {
    requestAccess: (...a: unknown[]) => mockRequestAccess(...a),
    currentAccess: (...a: unknown[]) => mockCurrentAccess(...a),
  },
}));

jest.mock('../src/markers/GlassesImportController', () => ({
  GlassesImportController: class {
    start = mockStart;
    stop = mockStop;
    sync = mockSync;
  },
}));

jest.mock('../src/markers/MarkerStore', () => ({ MarkerStore: class {} }));
jest.mock('../src/core/EntitlementStore', () => ({
  entitlementStore: { isPro: jest.fn(async () => false) },
}));
jest.mock('../src/wakeword/SpeechWakeWord', () => ({ SpeechWakeWord: class {} }));
jest.mock('../src/captioning/CaptionQueue', () => ({
  captionQueue: { enqueue: jest.fn(async () => {}) },
}));

const mockSettings = { glassesLibraryImport: true };
jest.mock('../src/core/SettingsStore', () => ({
  settingsStore: { get: jest.fn(async () => mockSettings) },
}));

function access(status: PhotoAccessStatus) {
  return { status, usable: status === 'authorized' };
}

/** A fresh singleton per test — it is module-scoped and holds live state. */
function freshService() {
  let service: typeof import('../src/services/glassesImport').glassesImport;
  jest.isolateModules(() => {
    service = require('../src/services/glassesImport').glassesImport;
  });
  return service!;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAppStateListeners.length = 0;
  mockSettings.glassesLibraryImport = true;
});

describe('photoAccessBlocker', () => {
  it('lets only full access through', () => {
    expect(photoAccessBlocker('authorized')).toBeNull();
  });

  it('names Selected Photos, and says picking more will not help', () => {
    const blocker = photoAccessBlocker('limited');
    expect(blocker).toContain('Selected Photos');
    expect(blocker).toContain('won’t help');
  });

  it('has something to say about every status', () => {
    const statuses: PhotoAccessStatus[] = [
      'limited',
      'denied',
      'restricted',
      'undetermined',
    ];
    for (const status of statuses) {
      expect(photoAccessBlocker(status)).toBeTruthy();
    }
  });
});

describe('glassesImport enable gate', () => {
  it('refuses to enable on limited access, and says why', async () => {
    mockRequestAccess.mockResolvedValue(access('limited'));
    const service = freshService();

    const blocker = await service.requestEnable();

    expect(blocker).toContain('Selected Photos');
    expect(service.blockedBecause).toBe(blocker);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('enables on full access', async () => {
    mockRequestAccess.mockResolvedValue(access('authorized'));
    const service = freshService();

    expect(await service.requestEnable()).toBeNull();
    expect(service.blockedBecause).toBeNull();
  });
});

describe('glassesImport syncWithSettings', () => {
  it('does not start when the setting is on but access is limited', async () => {
    mockCurrentAccess.mockResolvedValue(access('limited'));
    const service = freshService();

    await service.syncWithSettings();

    expect(mockStart).not.toHaveBeenCalled();
    expect(service.running).toBe(false);
    expect(service.blockedBecause).toContain('Selected Photos');
  });

  it('starts when the setting is on and access is full', async () => {
    mockCurrentAccess.mockResolvedValue(access('authorized'));
    const service = freshService();

    await service.syncWithSettings();

    expect(mockStart).toHaveBeenCalled();
    expect(service.running).toBe(true);
    expect(service.blockedBecause).toBeNull();
  });

  it('stops and warns when access is downgraded mid-session', async () => {
    mockCurrentAccess.mockResolvedValue(access('authorized'));
    const service = freshService();
    const seen: (string | null)[] = [];
    service.subscribe(blocker => seen.push(blocker));

    await service.syncWithSettings();
    expect(service.running).toBe(true);

    // The wearer drops Photos to Selected in Settings. Nothing tells the app;
    // the next foreground is the only chance to notice.
    mockCurrentAccess.mockResolvedValue(access('limited'));
    expect(mockAppStateListeners).toHaveLength(1);
    mockAppStateListeners[0]('active');
    await new Promise<void>(resolve => setImmediate(() => resolve()));

    expect(service.running).toBe(false);
    expect(service.blockedBecause).toContain('Selected Photos');
    expect(seen[seen.length - 1]).toContain('Selected Photos');
  });

  it('clears the warning when the setting is turned off', async () => {
    mockCurrentAccess.mockResolvedValue(access('limited'));
    const service = freshService();
    await service.syncWithSettings();
    expect(service.blockedBecause).not.toBeNull();

    mockSettings.glassesLibraryImport = false;
    await service.syncWithSettings();

    expect(service.blockedBecause).toBeNull();
  });
});
