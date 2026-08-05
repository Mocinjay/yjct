import { AppState, type AppStateStatus } from 'react-native';
import type { CaptureSession } from '../services/capture';
import { buildCaptureSession } from '../services/capture';
import type { Clip } from '../types';
import type { CaptureStatus } from './CaptureController';
import { createLogger } from './Logger';
import { settingsStore } from './SettingsStore';
import { ErrorCode } from './errors';

const log = createLogger('capture-session');

/** Automatic re-arms after a dropped link before the wearer has to intervene. */
const MAX_RECOVERY_ATTEMPTS = 3;
const RECOVERY_DELAY_MS = 4000;

export interface CaptureSessionSnapshot {
  status: CaptureStatus;
  /** Null until the first session finishes building. */
  session: CaptureSession | null;
  /**
   * Automatic recovery has given up. The wearer is walking around believing
   * they are armed, so the UI must say otherwise and offer a retry.
   */
  recoveryExhausted: boolean;
}

/** Injectable so the reconciler can be tested without React or a device. */
export interface CaptureSessionDeps {
  buildSession: () => Promise<CaptureSession>;
  /** Reports foreground/background. Defaults to React Native's AppState. */
  observeAppState: (onChange: (foreground: boolean) => void) => () => void;
}

const defaultDeps: CaptureSessionDeps = {
  buildSession: buildCaptureSession,
  observeAppState: onChange => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) =>
      onChange(state === 'active'),
    );
    return () => sub.remove();
  },
};

const IDLE_STATUS: CaptureStatus = {
  state: 'idle',
  bufferedSeconds: 0,
  bufferedAsOf: 0,
};

/**
 * Owns when capture is running.
 *
 * This logic used to live in eight `useEffect`s on ArmedScreen, and the
 * invariant it enforces — *capture runs exactly while the screen is showing,
 * the app is in the foreground, and the source is ready, unless a recording is
 * in flight* — was never written down in one place. It was the emergent result
 * of four effects that each independently called `arm()` or `disarm()`, plus
 * two refs coordinating between them. Adding a condition meant finding every
 * effect that could contradict it.
 *
 * Here there is exactly one function that decides — `reconcile()` — and every
 * input is a field. Nothing else calls `arm` or `disarm`.
 *
 * It is deliberately not a React hook: the rules have nothing to do with
 * rendering, and as plain TypeScript they are testable without a renderer.
 */
export class CaptureSessionManager {
  private deps: CaptureSessionDeps;
  private session: CaptureSession | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private unsubscribeAppState: (() => void) | null = null;

  // --- Inputs. Nothing else feeds the decision. ---
  private screenActive = false;
  private appForeground = true;
  /**
   * Set by the phone-camera viewfinder's `onInitialized`. Only the mock source
   * needs it — see `sourceReady`.
   */
  private cameraReady = false;

  // --- Derived / bookkeeping ---
  private status: CaptureStatus = IDLE_STATUS;
  private armed = false;
  private arming = false;
  private building: Promise<CaptureSession> | null = null;
  private recoveryAttempts = 0;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryExhausted = false;
  private listeners = new Set<(s: CaptureSessionSnapshot) => void>();

  constructor(deps: Partial<CaptureSessionDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  subscribe(listener: (s: CaptureSessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): CaptureSessionSnapshot {
    return {
      status: this.status,
      session: this.session,
      recoveryExhausted: this.recoveryExhausted,
    };
  }

  /**
   * The capture screen is showing (focused), or it is not.
   *
   * Focus rather than mount: React Navigation keeps screens below the top of
   * the stack mounted, so a mounted-but-covered Armed screen would otherwise
   * hold the glasses camera, the Bluetooth link, the H.264 writer, the mic and
   * per-segment speech recognition open the whole time the wearer was browsing
   * the library or watching a clip.
   */
  setScreenActive(active: boolean): void {
    if (this.screenActive === active) {
      return;
    }
    this.screenActive = active;
    if (active) {
      this.bindAppState();
    }
    this.reconcile();
  }

  /** The phone-camera viewfinder finished initialising. */
  notifySourceReady(): void {
    if (this.cameraReady) {
      return;
    }
    this.cameraReady = true;
    this.reconcile();
  }

  /**
   * Wearer-initiated retry after automatic recovery gave up. Resets the budget:
   * an explicit retry means new information (they refolded the glasses, walked
   * back into range) that the timer could not know about.
   */
  retry(): void {
    this.recoveryAttempts = 0;
    this.recoveryExhausted = false;
    this.armed = false;
    this.emit();
    this.reconcile();
  }

  /**
   * Drop the built session so the next activation constructs a fresh one.
   * Settings — device kind, wake-word provider, buffer length — are read when
   * the session is built, so this is how a settings change takes effect.
   */
  invalidate(): void {
    if (!this.session && !this.building) {
      return;
    }
    log.debug('session invalidated — rebuilding');
    this.teardown();
    // Rebuild straight away if capture is still wanted, rather than waiting for
    // the next focus change.
    this.reconcile();
  }

  // --- Delegated capture actions ---

  captureNow(): Promise<Clip | null> {
    return (
      this.session?.controller.captureNow() ?? Promise.resolve(null)
    );
  }

  startClip(): void {
    this.session?.controller.startClip();
  }

  stopClip(): Promise<Clip | null> {
    return this.session?.controller.stopClip() ?? Promise.resolve(null);
  }

  /** The rolling look-back window, so the UI can cap what it displays. */
  get lookBackSeconds(): number | null {
    return this.session?.controller.lookBackSeconds ?? null;
  }

  // --- The single decision point ---

  /**
   * The glasses source is ready as soon as the session exists — the native
   * bridge opens the stream itself. The phone-camera mock is not: arming before
   * the viewfinder's `onInitialized` fails, so it waits to be told.
   *
   * Ready before there is a session at all, so that the first activation is
   * allowed to build one; the mock gate applies once the kind is known.
   */
  private get sourceReady(): boolean {
    if (!this.session) {
      return true;
    }
    return this.session.mockSource ? this.cameraReady : true;
  }

  /**
   * Capture should be running exactly when the screen is showing, the app is in
   * the foreground, and the source can start.
   */
  private get shouldCapture(): boolean {
    return this.screenActive && this.appForeground && this.sourceReady;
  }

  /**
   * A recording or a save owns the writer, and the wearer is deliberately
   * capturing. Navigation and backgrounding must never interrupt one.
   */
  private get busyCapturing(): boolean {
    return this.status.state === 'recording' || this.status.state === 'saving';
  }

  private reconcile(): void {
    if (this.shouldCapture) {
      this.clearRecoveryTimer();
      // `ensureArmed` handles its own failures; this catch is for the case
      // where that handling itself throws, which would otherwise surface as an
      // unhandled rejection with no context.
      this.ensureArmed().catch(err =>
        log.error('arming reconciliation failed', err, ErrorCode.CaptureArmFailed),
      );
      return;
    }
    if (this.busyCapturing) {
      log.debug('deferring teardown — a capture is in flight');
      return;
    }
    this.teardown();
  }

  private async ensureArmed(): Promise<void> {
    if (this.armed || this.arming) {
      return;
    }
    this.arming = true;
    try {
      const session = await this.ensureSession();
      // Conditions can change across the await — the wearer may have navigated
      // away while the session was being built.
      if (!this.shouldCapture) {
        log.debug('no longer needed by the time the session was ready');
        return;
      }
      this.armed = true;
      await session.controller.arm();
      this.recoveryAttempts = 0;
      this.recoveryExhausted = false;
      this.emit();
    } catch (err) {
      // The controller has already logged and published the error; clearing the
      // latch is what lets recovery (or a retry) try again.
      this.armed = false;
      log.expected('arm attempt failed', err, ErrorCode.CaptureArmFailed);
      this.scheduleRecovery();
    } finally {
      this.arming = false;
    }
  }

  private async ensureSession(): Promise<CaptureSession> {
    if (this.session) {
      return this.session;
    }
    // Concurrent callers share one build; two sessions would mean two writers
    // competing for the same camera.
    if (!this.building) {
      this.building = this.deps.buildSession();
    }
    try {
      const session = await this.building;
      this.session = session;
      this.unsubscribeStatus?.();
      this.unsubscribeStatus = session.controller.subscribe(status => {
        this.status = status;
        this.emit();
        // A source-reported failure lands here rather than on the `arm()`
        // promise, which has long since resolved.
        if (status.state === 'error') {
          this.armed = false;
          this.scheduleRecovery();
        }
      });
      this.emit();
      return session;
    } finally {
      this.building = null;
    }
  }

  private teardown(): void {
    this.clearRecoveryTimer();
    const session = this.session;
    this.armed = false;
    this.cameraReady = false;
    if (!session) {
      return;
    }
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    this.session = null;
    this.status = IDLE_STATUS;
    this.emit();
    session.controller
      .disarm()
      .catch(err => log.error('disarm failed', err, ErrorCode.CaptureDisarmFailed));
  }

  // --- Recovery ---

  /**
   * A stalled or dropped glasses link leaves capture in `error`, and the wearer
   * cannot see it — the phone is in a pocket, which is the entire point of the
   * product. Re-arm automatically, but a bounded number of times: if the
   * glasses are folded, flat or out of range, renegotiating forever means a
   * stop/start chime every few seconds and a session that never settles.
   */
  private scheduleRecovery(): void {
    if (!this.shouldCapture || this.recoveryTimer || this.recoveryExhausted) {
      return;
    }
    if (this.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      this.recoveryExhausted = true;
      log.error(
        `gave up re-arming after ${MAX_RECOVERY_ATTEMPTS} attempts — capture is stopped until the wearer retries`,
        this.status.lastError,
        ErrorCode.GlassesSessionFailed,
      );
      this.emit();
      return;
    }
    this.recoveryAttempts += 1;
    log.warn('capture dropped — re-arming', {
      attempt: this.recoveryAttempts,
      of: MAX_RECOVERY_ATTEMPTS,
      delayMs: RECOVERY_DELAY_MS,
      lastError: this.status.lastError,
    });
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      this.armed = false;
      this.reconcile();
    }, RECOVERY_DELAY_MS);
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  // --- App lifecycle ---

  private bindAppState(): void {
    if (this.unsubscribeAppState) {
      return;
    }
    this.unsubscribeAppState = this.deps.observeAppState(foreground => {
      if (this.appForeground === foreground) {
        return;
      }
      this.appForeground = foreground;
      if (!foreground) {
        // iOS may tear the native session down while the app is away, and the
        // phone camera's `onInitialized` has to fire again before the mock can
        // arm. Treating the camera as unready is what makes the return trip
        // wait for it rather than arming into a dead session.
        this.cameraReady = false;
      }
      log.debug(`app ${foreground ? 'foregrounded' : 'backgrounded'}`);
      this.reconcile();
    });
  }

  private emit(): void {
    const snapshot = this.snapshot();
    this.listeners.forEach(l => l(snapshot));
  }
}

/**
 * App-scoped, so capture survives the Armed screen unmounting. The session
 * itself is still built per activation, which is what keeps a settings change
 * applying to the next arming.
 */
export const captureSessionManager = new CaptureSessionManager();

// Device kind, wake-word provider and buffer length are read when the session
// is built, so a settings change only takes effect once the built session is
// dropped. Navigating to Settings blurs the capture screen and would release it
// anyway; this makes it true regardless of how the change arrives.
settingsStore.subscribe(() => captureSessionManager.invalidate());
