import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BUFFER_SECONDS_MAX,
  BUFFER_SECONDS_MIN,
  DEFAULT_SETTINGS,
} from '../config';
import type { Settings } from '../types';
import { Emitter } from './Emitter';
import { createLogger } from './Logger';
import { ErrorCode } from './errors';

const log = createLogger('settings');

const KEY = 'settings.v3';
/** Newest first: the first one that exists is the record to migrate from. */
const LEGACY_KEYS = ['settings.v2', 'settings.v1'];

export class SettingsStore {
  private cached: Settings | null = null;
  private changes = new Emitter<Settings>();

  async get(): Promise<Settings> {
    if (this.cached) {
      return this.cached;
    }
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (raw) {
        this.cached = {
          ...DEFAULT_SETTINGS,
          ...(JSON.parse(raw) as Partial<Settings>),
        };
      } else {
        // Newest first, so a v2 record wins over a v1 one left beside it.
        let legacy: string | null = null;
        let legacyKey: string | null = null;
        for (const candidate of LEGACY_KEYS) {
          legacy = await AsyncStorage.getItem(candidate);
          if (legacy) {
            legacyKey = candidate;
            break;
          }
        }
        const migrated: Settings = legacy
          ? { ...DEFAULT_SETTINGS, ...(JSON.parse(legacy) as Partial<Settings>) }
          : DEFAULT_SETTINGS;
        // One-time v1 → v2 migration, and v1 only: those defaults were the mock
        // trigger and the "fade away" phrase, so a 'mock' stored there is the
        // old default rather than a decision. In a v2 record it is an explicit
        // choice — the wearer opened Settings and picked the manual trigger —
        // and coercing that to speech silently takes their button away.
        if (legacyKey === 'settings.v1' && migrated.wakeWord.provider === 'mock') {
          migrated.wakeWord = { ...migrated.wakeWord, provider: 'speech' };
        }
        // v2 → v3: glasses-library import is on by default now, and the stored
        // `false` every v2 install carries is not a decision — the switch
        // defaulted off and was buried in Settings, so almost nobody ever saw
        // it. Since it is the only path to 1520x2032 (config.ts), a stored
        // `false` here is far more likely to be "never found it" than "tried
        // it and said no". Forced on exactly once, at the version boundary;
        // turning it off afterwards is a v3 choice and sticks like any other.
        migrated.glassesLibraryImport = true;
        this.cached = migrated;
        await AsyncStorage.setItem(KEY, JSON.stringify(migrated));
      }
    } catch (err) {
      // Silently falling back looks identical to a first launch, so a corrupt
      // record quietly reset the wearer's buffer length and device choice on
      // every open with nothing anywhere to say so.
      log.error(
        'stored settings could not be read — falling back to defaults',
        err,
        ErrorCode.StorageIndexUnreadable,
      );
      this.cached = DEFAULT_SETTINGS;
    }
    // Glasses-only: stored 'mock' choices from earlier builds are retired.
    if (this.cached.deviceKind !== 'mwdat') {
      this.cached = { ...this.cached, deviceKind: 'mwdat' };
    }
    // The Porcupine provider is retired; installs that stored it land back
    // on keyless speech recognition.
    const { provider } = this.cached.wakeWord;
    if (provider !== 'speech' && provider !== 'mock') {
      this.cached = { ...this.cached, wakeWord: { provider: 'speech' } };
    }
    return this.cached;
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
    this.changes.emit(next);
    return next;
  }

  subscribe(listener: (s: Settings) => void): () => void {
    return this.changes.subscribe(listener);
  }
}

export const settingsStore = new SettingsStore();
