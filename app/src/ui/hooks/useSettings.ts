import { useCallback, useEffect, useState } from 'react';
import { createLogger } from '../../core/Logger';
import { settingsStore } from '../../core/SettingsStore';
import { ErrorCode } from '../../core/errors';
import type { Settings } from '../../types';

const log = createLogger('settings');

export interface UseSettings {
  /** Null until the first read resolves. */
  settings: Settings | null;
  update: (patch: Partial<Settings>) => Promise<void>;
}

/**
 * Settings, kept in sync with the store.
 *
 * `update` deliberately does not set local state itself — the store notifies
 * every subscriber, so the write path and the external-change path converge on
 * one update instead of the screen briefly disagreeing with the store.
 */
export function useSettings(): UseSettings {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    let active = true;
    settingsStore
      .get()
      .then(s => {
        if (active) {
          setSettings(s);
        }
      })
      .catch(err =>
        log.error('could not read settings', err, ErrorCode.StorageIndexUnreadable),
      );
    const unsubscribe = settingsStore.subscribe(s => {
      if (active) {
        setSettings(s);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const update = useCallback(async (patch: Partial<Settings>) => {
    try {
      await settingsStore.update(patch);
    } catch (err) {
      log.error('could not save settings', err, ErrorCode.StorageWriteFailed);
    }
  }, []);

  return { settings, update };
}
