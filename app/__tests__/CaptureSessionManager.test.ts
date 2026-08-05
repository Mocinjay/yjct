/**
 * The manager's default `buildSession` is the real composition root, which
 * statically pulls in RNFS, vision-camera and every native bridge. Every test
 * here injects its own builder, so the seam is stubbed at exactly the boundary
 * the manager already depends on rather than mocking the graph behind it.
 */
jest.mock('../src/services/capture', () => ({
  buildCaptureSession: jest.fn(),
}));

/** Reached via the module-scope singleton's settings subscription. */
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (k: string) => store.get(k) ?? null),
      setItem: jest.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
    },
  };
});

import {
  CaptureSessionManager,
  type CaptureSessionDeps,
} from '../src/core/CaptureSessionManager';
import type { CaptureStatus } from '../src/core/CaptureController';
import type { CaptureSession } from '../src/services/capture';

/**
 * A controller stand-in that records the arm/disarm calls the manager makes and
 * lets a test drive the status stream — which is how a dropped glasses link
 * reports itself in the real thing.
 */
class FakeController {
  armCalls = 0;
  disarmCalls = 0;
  armRejectsWith: Error | null = null;
  lookBackSeconds = 30;
  private listeners = new Set<(s: CaptureStatus) => void>();
  private status: CaptureStatus = {
    state: 'idle',
    bufferedSeconds: 0,
    bufferedAsOf: 0,
  };

  subscribe(listener: (s: CaptureStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  async arm(): Promise<void> {
    this.armCalls += 1;
    if (this.armRejectsWith) {
      this.emit({ state: 'error', lastError: this.armRejectsWith.message });
      throw this.armRejectsWith;
    }
    this.emit({ state: 'armed' });
  }

  async disarm(): Promise<void> {
    this.disarmCalls += 1;
    this.emit({ state: 'idle' });
  }

  async captureNow() {
    return null;
  }
  startClip() {}
  async stopClip() {
    return null;
  }

  /** Drives the status stream the way the real source's error channel does. */
  emit(patch: Partial<CaptureStatus>): void {
    this.status = { ...this.status, ...patch } as CaptureStatus;
    this.listeners.forEach(l => l(this.status));
  }
}

function setup(
  options: { mock?: boolean; beforeBuildResolves?: () => Promise<void> } = {},
) {
  const controller = new FakeController();
  let appStateListener: ((foreground: boolean) => void) | null = null;
  let buildCount = 0;

  const session = {
    controller,
    ...(options.mock ? { mockSource: {} } : {}),
  } as unknown as CaptureSession;

  const deps: CaptureSessionDeps = {
    buildSession: async () => {
      buildCount += 1;
      await options.beforeBuildResolves?.();
      return session;
    },
    observeAppState: onChange => {
      appStateListener = onChange;
      return () => {
        appStateListener = null;
      };
    },
  };

  const manager = new CaptureSessionManager(deps);
  return {
    manager,
    controller,
    getBuildCount: () => buildCount,
    background: () => appStateListener?.(false),
    foreground: () => appStateListener?.(true),
  };
}

/** Lets the manager's internal awaits settle. */
const settle = () => Promise.resolve().then(() => Promise.resolve());

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('the arming invariant', () => {
  it('does not arm before the screen is showing', async () => {
    const { controller } = setup();
    await settle();
    expect(controller.armCalls).toBe(0);
  });

  it('arms once the screen is showing', async () => {
    const { manager, controller } = setup();
    manager.setScreenActive(true);
    await settle();
    expect(controller.armCalls).toBe(1);
  });

  it('disarms when the screen stops showing', async () => {
    const { manager, controller } = setup();
    manager.setScreenActive(true);
    await settle();
    manager.setScreenActive(false);
    expect(controller.disarmCalls).toBe(1);
  });

  it('does not arm twice when the screen re-reports the same state', async () => {
    const { manager, controller } = setup();
    manager.setScreenActive(true);
    manager.setScreenActive(true);
    await settle();
    expect(controller.armCalls).toBe(1);
  });

  it('builds only one session when reactivated while the build is still in flight', async () => {
    // Two sessions would mean two writers competing for one camera, so the
    // second activation must join the build already running rather than start
    // its own.
    // Definite-assignment: the executor runs synchronously, but TypeScript's
    // control-flow analysis cannot see that and narrows the binding to `never`.
    let releaseBuild!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseBuild = resolve;
    });
    const { manager, controller, getBuildCount } = setup({
      beforeBuildResolves: () => gate,
    });

    manager.setScreenActive(true);
    await settle();
    expect(getBuildCount()).toBe(1);

    // A second activation arrives before the first build has resolved.
    manager.notifySourceReady();
    await settle();

    releaseBuild();
    await settle();

    expect(getBuildCount()).toBe(1);
    expect(controller.armCalls).toBe(1);
  });
});

describe('recordings are never interrupted', () => {
  it('refuses to tear down while an extended recording is running', async () => {
    const { manager, controller } = setup();
    manager.setScreenActive(true);
    await settle();
    controller.emit({ state: 'recording' });

    manager.setScreenActive(false);

    expect(controller.disarmCalls).toBe(0);
  });

  it('refuses to tear down mid-save', async () => {
    const { manager, controller } = setup();
    manager.setScreenActive(true);
    await settle();
    controller.emit({ state: 'saving' });

    manager.setScreenActive(false);

    expect(controller.disarmCalls).toBe(0);
  });
});

describe('app lifecycle', () => {
  it('releases capture when the app goes to the background', async () => {
    const { manager, controller, background } = setup();
    manager.setScreenActive(true);
    await settle();

    background();

    expect(controller.disarmCalls).toBe(1);
  });

  it('re-arms on return to the foreground', async () => {
    const { manager, controller, background, foreground } = setup();
    manager.setScreenActive(true);
    await settle();
    background();

    foreground();
    await settle();

    expect(controller.armCalls).toBe(2);
  });

  it('does not wake capture if the screen is no longer showing', async () => {
    const { manager, controller, background, foreground } = setup();
    manager.setScreenActive(true);
    await settle();
    background();
    manager.setScreenActive(false);

    foreground();
    await settle();

    expect(controller.armCalls).toBe(1);
  });
});

describe('the phone-camera mock', () => {
  it('waits for the viewfinder before arming', async () => {
    const { manager, controller } = setup({ mock: true });
    manager.setScreenActive(true);
    await settle();
    expect(controller.armCalls).toBe(0);

    manager.notifySourceReady();
    await settle();
    expect(controller.armCalls).toBe(1);
  });
});

describe('recovery', () => {
  it('re-arms automatically after the source reports a failure', async () => {
    const { manager, controller } = setup();
    manager.setScreenActive(true);
    await settle();

    controller.emit({ state: 'error', lastError: 'link dropped' });
    jest.advanceTimersByTime(4000);
    await settle();

    expect(controller.armCalls).toBe(2);
  });

  it('gives up after a bounded number of attempts instead of looping forever', async () => {
    const { manager, controller } = setup();
    manager.setScreenActive(true);
    await settle();
    controller.armRejectsWith = new Error('glasses are folded');

    for (let i = 0; i < 10; i++) {
      controller.emit({ state: 'error', lastError: 'glasses are folded' });
      jest.advanceTimersByTime(4000);
      await settle();
    }

    // The initial successful arm plus exactly three recovery attempts.
    expect(controller.armCalls).toBe(1 + 3);
    expect(manager.snapshot().recoveryExhausted).toBe(true);
  });

  it('an explicit retry resets the budget', async () => {
    const { manager, controller } = setup();
    manager.setScreenActive(true);
    await settle();
    controller.armRejectsWith = new Error('out of range');
    for (let i = 0; i < 5; i++) {
      controller.emit({ state: 'error', lastError: 'out of range' });
      jest.advanceTimersByTime(4000);
      await settle();
    }
    expect(manager.snapshot().recoveryExhausted).toBe(true);

    // The wearer unfolded the glasses — information the timer cannot have.
    controller.armRejectsWith = null;
    manager.retry();
    await settle();

    expect(manager.snapshot().recoveryExhausted).toBe(false);
    expect(manager.snapshot().status.state).toBe('armed');
  });

  it('stops trying to recover once the screen is no longer showing', async () => {
    const { manager, controller } = setup();
    manager.setScreenActive(true);
    await settle();
    controller.emit({ state: 'error', lastError: 'link dropped' });

    manager.setScreenActive(false);
    jest.advanceTimersByTime(20_000);
    await settle();

    expect(controller.armCalls).toBe(1);
  });
});

describe('settings changes', () => {
  it('rebuilds the session so new settings take effect', async () => {
    const { manager, getBuildCount } = setup();
    manager.setScreenActive(true);
    await settle();
    expect(getBuildCount()).toBe(1);

    manager.invalidate();
    await settle();

    expect(getBuildCount()).toBe(2);
  });

  it('is a no-op when there is no session to rebuild', async () => {
    const { manager, getBuildCount } = setup();
    manager.invalidate();
    await settle();
    expect(getBuildCount()).toBe(0);
  });
});
