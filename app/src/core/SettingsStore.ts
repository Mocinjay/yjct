import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BUFFER_SECONDS_MAX,
  BUFFER_SECONDS_MIN,
  DEFAULT_SETTINGS,
} from '../config';
import type { Settings } from '../types';
import { createLogger } from './Logger';
import { ErrorCode } from './errors';

const log = createLogger('settings');

const KEY = 'settings.v2';
const LEGACY_KEY = 'settings.v1';

export class SettingsStore {
  private cached: Settings | null = null;
  private listeners = new Set<(s: Settings) => void>();

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
    this.listeners.forEach(l => l(next));
    return next;
  }

  subscribe(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const settingsStore = new SettingsStore();
