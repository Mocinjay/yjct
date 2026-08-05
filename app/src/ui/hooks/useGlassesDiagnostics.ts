import { useCallback, useEffect, useState } from 'react';
import { createLogger } from '../../core/Logger';
import { ErrorCode, describe } from '../../core/errors';
import {
  MWDATNative,
  mwdatAvailable,
  mwdatEvents,
  type MWDATDiagnostics,
} from '../../native/MWDATNative';

const log = createLogger('glasses-diagnostics');

/** The bridge has no change notification for most of this, so it is polled. */
const POLL_MS = 2000;

export interface UseGlassesDiagnostics {
  diagnostics: MWDATDiagnostics | null;
  /** Last reported failure, or null. Wearer-facing. */
  error: string | null;
  setError: (message: string | null) => void;
  refresh: () => void;
  available: boolean;
}

/**
 * Polls the glasses bridge for registration, device, permission and stream
 * state, and folds in the events that report the same things asynchronously.
 *
 * Kept out of the screen because it is the mechanical half — a timer, four
 * event subscriptions and their teardown. What the screen does with the result
 * (the preview handshake, the registration bounce through the Meta AI app) is
 * genuinely screen-specific flow and stays there.
 */
export function useGlassesDiagnostics(): UseGlassesDiagnostics {
  const [diagnostics, setDiagnostics] = useState<MWDATDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const available = mwdatAvailable();

  const refresh = useCallback(() => {
    if (!mwdatAvailable()) {
      setError('Meta glasses support is iOS-only for now.');
      return;
    }
    MWDATNative.getDiagnostics()
      .then(setDiagnostics)
      .catch(err => {
        log.error('could not read glasses diagnostics', err, ErrorCode.GlassesUnavailable);
        setError(describe(err));
      });
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    if (!available) {
      return () => clearInterval(timer);
    }
    const emitter = mwdatEvents();
    const subs = [
      emitter.addListener('MWDATRegistrationState', refresh),
      emitter.addListener('MWDATDevices', refresh),
      emitter.addListener('MWDATError', (e: { message: string }) => {
        log.warn('glasses bridge reported an error', { message: e.message });
        setError(e.message);
      }),
    ];
    return () => {
      clearInterval(timer);
      subs.forEach(s => s.remove());
    };
  }, [refresh, available]);

  return { diagnostics, error, setError, refresh, available };
}
