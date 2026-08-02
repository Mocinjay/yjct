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

  it('defaults to keyless speech recognition', async () => {
    const store = new SettingsStore();
    const settings = await store.get();
    expect(settings.wakeWord.provider).toBe('speech');
    expect(settings.bufferSeconds).toBe(30);
  });

  it('retires a stored porcupine provider back to speech', async () => {
    await AsyncStorage.setItem(
      'settings.v2',
      JSON.stringify({
        bufferSeconds: 60,
        deviceKind: 'mwdat',
        wakeWord: { provider: 'porcupine', keyword: 'jarvis' },
      }),
    );
    const store = new SettingsStore();
    const settings = await store.get();
    expect(settings.wakeWord.provider).toBe('speech');
    expect(settings.bufferSeconds).toBe(60); // everything else untouched
  });

  it('leaves an explicit manual-trigger choice alone', async () => {
    await AsyncStorage.setItem(
      'settings.v2',
      JSON.stringify({ deviceKind: 'mwdat', wakeWord: { provider: 'mock' } }),
    );
    const store = new SettingsStore();
    expect((await store.get()).wakeWord.provider).toBe('mock');
  });

  it('clamps buffer seconds into the 30-90 range on update', async () => {
    const store = new SettingsStore();
    expect((await store.update({ bufferSeconds: 300 })).bufferSeconds).toBe(90);
    expect((await store.update({ bufferSeconds: 5 })).bufferSeconds).toBe(30);
  });
});
