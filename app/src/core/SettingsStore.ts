import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BUFFER_SECONDS_MAX,
  BUFFER_SECONDS_MIN,
  DEFAULT_SETTINGS,
} from '../config';
import type { Settings } from '../types';

const KEY = 'settings.v1';

export class SettingsStore {
  private cached: Settings | null = null;
  private listeners = new Set<(s: Settings) => void>();

  async get(): Promise<Settings> {
    if (this.cached) {
      return this.cached;
    }
    try {
      const raw = await AsyncStorage.getItem(KEY);
      this.cached = raw
        ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
        : DEFAULT_SETTINGS;
      // Brand migration: the old "fade away" default needed a custom-trained
      // model; "jarvis" is a Porcupine built-in. Migrate the old default only.
      if (this.cached.wakeWord.keyword === 'fade away') {
        this.cached = {
          ...this.cached,
          wakeWord: { ...this.cached.wakeWord, keyword: 'jarvis' },
        };
      }
    } catch {
      this.cached = DEFAULT_SETTINGS;
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
