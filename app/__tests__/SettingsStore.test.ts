jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (k: string) => store.get(k) ?? null),
      setItem: jest.fn(async (k: string, v: string) => {
        store.set(k, v);
      }),
      removeItem: jest.fn(async (k: string) => {
        store.delete(k);
      }),
      clear: jest.fn(async () => {
        store.clear();
      }),
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import { SettingsStore } from '../src/core/SettingsStore';

describe('SettingsStore', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('defaults to the built-in jarvis wake word', async () => {
    const store = new SettingsStore();
    const settings = await store.get();
    expect(settings.wakeWord.keyword).toBe('jarvis');
    expect(settings.bufferSeconds).toBe(30);
  });

  it('migrates the legacy "fade away" keyword to jarvis', async () => {
    await AsyncStorage.setItem(
      'settings.v1',
      JSON.stringify({
        bufferSeconds: 60,
        wakeWord: { provider: 'porcupine', keyword: 'fade away' },
      }),
    );
    const store = new SettingsStore();
    const settings = await store.get();
    expect(settings.wakeWord.keyword).toBe('jarvis');
    expect(settings.bufferSeconds).toBe(60); // everything else untouched
    expect(settings.wakeWord.provider).toBe('porcupine');
  });

  it('leaves genuinely custom keywords alone', async () => {
    await AsyncStorage.setItem(
      'settings.v1',
      JSON.stringify({ wakeWord: { provider: 'porcupine', keyword: 'clip it chief' } }),
    );
    const store = new SettingsStore();
    expect((await store.get()).wakeWord.keyword).toBe('clip it chief');
  });

  it('clamps buffer seconds into the 30-90 range on update', async () => {
    const store = new SettingsStore();
    expect((await store.update({ bufferSeconds: 300 })).bufferSeconds).toBe(90);
    expect((await store.update({ bufferSeconds: 5 })).bufferSeconds).toBe(30);
  });
});
