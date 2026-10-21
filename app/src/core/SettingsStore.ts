import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BUFFER_SECONDS_MAX,
  BUFFER_SECONDS_MIN,
  DEFAULT_SETTINGS,
} from '../config';
import type { Settings } from '../types';

const KEY = 'settings.v2';
const LEGACY_KEY = 'settings.v1';
/** Set once the chime-off default has been applied to this install. */
const CHIME_OFF_MIGRATION_KEY = 'settings.migrations.chimeOff';

export class SettingsStore {
  private cached: Settings | null = null;
  private listeners = new Set<(s: Settings) => void>();
  /**
   * The chime-off default was applied in memory but could not be saved. The
   * next successful save of the settings carries it, so that save also marks
   * the migration done — otherwise the retry next launch could not tell the
   * old default from a chime the wearer turned back on in the meantime.
   */
  private chimeOffUnpersisted = false;

  async get(): Promise<Settings> {
    if (this.cached) {
      return this.cached;
    }
    let loaded = false;
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (raw) {
        this.cached = {
          ...DEFAULT_SETTINGS,
          ...(JSON.parse(raw) as Partial<Settings>),
        };
      } else {
        // One-time v1 → v2 migration: old defaults were the mock trigger
        // and the "fade away" phrase; the product default is now keyless
        // speech recognition for "clypso". Explicit v2 choices stick.
        const legacy = await AsyncStorage.getItem(LEGACY_KEY);
        const migrated: Settings = legacy
          ? { ...DEFAULT_SETTINGS, ...(JSON.parse(legacy) as Partial<Settings>) }
          : DEFAULT_SETTINGS;
        if (migrated.wakeWord.provider === 'mock') {
          migrated.wakeWord = { ...migrated.wakeWord, provider: 'speech' };
        }
        this.cached = migrated;
        await AsyncStorage.setItem(KEY, JSON.stringify(migrated));
      }
      loaded = true;
    } catch {
      this.cached = DEFAULT_SETTINGS;
    }
    if (loaded) {
      await this.applyChimeOffDefault();
    }
    // The Porcupine provider is retired; installs that stored it land back
    // on keyless speech recognition.
    const { provider } = this.cached.wakeWord;
    if (provider !== 'speech' && provider !== 'mock') {
      this.cached = { ...this.cached, wakeWord: { provider: 'speech' } };
    }
    return this.cached;
  }

  /**
   * One-time: the glasses chime used to default to on, so every install that
   * ever saved settings stored `true` without anyone choosing it. It is now off
   * by default (see DEFAULT_SETTINGS); stored installs are switched off once,
   * and from then on whatever the wearer picks sticks.
   *
   * Kept apart from the load on purpose: a storage error here must not throw
   * away settings that loaded fine. The change is applied in memory first; if
   * persisting it fails, the next settings save finishes it (see
   * `chimeOffUnpersisted`), or failing that the next launch retries.
   */
  private async applyChimeOffDefault(): Promise<void> {
    try {
      if ((await AsyncStorage.getItem(CHIME_OFF_MIGRATION_KEY)) !== null) {
        return;
      }
      this.chimeOffUnpersisted = true;
      if (this.cached?.glassesChime) {
        this.cached = { ...this.cached, glassesChime: false };
        await AsyncStorage.setItem(KEY, JSON.stringify(this.cached));
      }
      await AsyncStorage.setItem(CHIME_OFF_MIGRATION_KEY, '1');
      this.chimeOffUnpersisted = false;
    } catch {
      // Finished by the next save, or retried on the next launch.
    }
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.get();
    const next: Settings = { ...current, ...patch };
    next.bufferSeconds = Math.min(
      BUFFER_SECONDS_MAX,
      Math.max(BUFFER_SECONDS_MIN, next.bufferSeconds),
    );
    this.cached = next;
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
    if (this.chimeOffUnpersisted) {
      // `next` was built on the migrated settings, so what was just saved is
      // either the migrated chime-off or the wearer's own choice since.
      try {
        await AsyncStorage.setItem(CHIME_OFF_MIGRATION_KEY, '1');
        this.chimeOffUnpersisted = false;
      } catch {
        // Retried on the next save or launch.
      }
    }
    this.listeners.forEach(l => l(next));
    return next;
  }

  subscribe(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const settingsStore = new SettingsStore();
