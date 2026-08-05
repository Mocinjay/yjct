import { useEffect, useMemo, useState } from 'react';
import {
  captureSessionManager,
  type CaptureSessionSnapshot,
} from '../../core/CaptureSessionManager';
import { createLogger } from '../../core/Logger';
import { ErrorCode } from '../../core/errors';

const log = createLogger('armed-screen');

export interface UseCaptureSession extends CaptureSessionSnapshot {
  /** Save the buffered look-back window now. */
  clipNow: () => void;
  /** Begin an extended recording: look-back plus everything from here. */
  startExtended: () => void;
  stopExtended: () => void;
  /** Wearer-initiated re-arm after automatic recovery gave up. */
  retry: () => void;
  /** The phone-camera viewfinder finished initialising. */
  notifySourceReady: () => void;
  lookBackSeconds: number | null;
}

/**
 * Binds a screen to the capture session.
 *
 * The screen reports one fact — whether it is showing — and gets back what to
 * render. Every rule about *when* capture runs lives in the manager, which is
 * plain TypeScript and tested without a renderer.
 */
export function useCaptureSession(active: boolean): UseCaptureSession {
  const [snapshot, setSnapshot] = useState<CaptureSessionSnapshot>(() =>
    captureSessionManager.snapshot(),
  );

  useEffect(() => captureSessionManager.subscribe(setSnapshot), []);

  useEffect(() => {
    captureSessionManager.setScreenActive(active);
  }, [active]);

  // Releasing on unmount as well as on blur: a screen that is destroyed while
  // focused (a navigation reset) never reports a blur.
  useEffect(() => () => captureSessionManager.setScreenActive(false), []);

  const actions = useMemo(
    () => ({
      // The manager reports its own failures through `status.lastError`; these
      // only catch a rejection it did not expect to make.
      clipNow: () => {
        captureSessionManager
          .captureNow()
          .catch(err => log.error('clip now failed', err, ErrorCode.CaptureSaveFailed));
      },
      startExtended: () => captureSessionManager.startClip(),
      stopExtended: () => {
        captureSessionManager
          .stopClip()
          .catch(err =>
            log.error('stopping extended clip failed', err, ErrorCode.CaptureSaveFailed),
          );
      },
      retry: () => captureSessionManager.retry(),
      notifySourceReady: () => captureSessionManager.notifySourceReady(),
    }),
    [],
  );

  return {
    ...snapshot,
    ...actions,
    lookBackSeconds: captureSessionManager.lookBackSeconds,
  };
}
