import { CaptureController } from '../core/CaptureController';
import { settingsStore } from '../core/SettingsStore';
import type { DeviceVideoSource } from '../device/DeviceVideoSource';
import { MockDeviceSource } from '../device/MockDeviceSource';
import { MWDATSource } from '../device/MWDATSource';
import type { Settings } from '../types';
import { MockWakeWord } from '../wakeword/MockWakeWord';
import { PorcupineWakeWord } from '../wakeword/PorcupineWakeWord';
import type { WakeWordProvider } from '../wakeword/WakeWordProvider';

/**
 * Composition root for a capture session. A fresh controller is built per
 * arming so settings changes (device, wake word, buffer length) apply on
 * the next session.
 */
export interface CaptureSession {
  controller: CaptureController;
  /** Set when the mock device is active — the Armed screen mounts the viewfinder. */
  mockSource?: MockDeviceSource;
  /** Set when the mock wake word is active — the Armed screen shows a trigger button. */
  mockWakeWord?: MockWakeWord;
}

export async function buildCaptureSession(): Promise<CaptureSession> {
  const settings = await settingsStore.get();
  const { source, mockSource } = buildSource(settings);
  const { wakeWord, mockWakeWord } = buildWakeWord(settings);
  return {
    controller: new CaptureController(source, wakeWord, settings.bufferSeconds),
    mockSource,
    mockWakeWord,
  };
}

function buildSource(settings: Settings): {
  source: DeviceVideoSource;
  mockSource?: MockDeviceSource;
} {
  if (settings.deviceKind === 'mwdat') {
    return { source: new MWDATSource() };
  }
  const mockSource = new MockDeviceSource();
  return { source: mockSource, mockSource };
}

function buildWakeWord(settings: Settings): {
  wakeWord: WakeWordProvider;
  mockWakeWord?: MockWakeWord;
} {
  const { provider, picovoiceAccessKey, keyword } = settings.wakeWord;
  if (provider === 'porcupine' && picovoiceAccessKey) {
    return { wakeWord: new PorcupineWakeWord(picovoiceAccessKey, keyword) };
  }
  const mockWakeWord = new MockWakeWord();
  return { wakeWord: mockWakeWord, mockWakeWord };
}
