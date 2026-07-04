export interface Clip {
  id: string;
  name: string;
  /** Absolute path to the clip MP4. */
  filePath: string;
  /** Absolute path to the poster-frame JPEG. */
  thumbnailPath: string;
  /** Epoch ms when the trigger fired. */
  capturedAt: number;
  durationSec: number;
  sourceKind: DeviceKind;
}

export type DeviceKind = 'mock' | 'mwdat';

export interface Segment {
  /** Absolute file path of the recorded segment. */
  path: string;
  /** Epoch ms when recording of this segment started. */
  startedAt: number;
  durationSec: number;
}

export interface Settings {
  /** Rolling buffer window the user wants captured, 30–90s. */
  bufferSeconds: number;
  deviceKind: DeviceKind;
  wakeWord: WakeWordConfig;
}

export interface WakeWordConfig {
  /**
   * speech    — OS built-in speech recognition, keyless (default)
   * porcupine — Picovoice keyword spotting (needs a free access key)
   * mock      — manual on-screen trigger button (dev/simulator)
   */
  provider: 'speech' | 'mock' | 'porcupine';
  /** Picovoice access key; required for the porcupine provider. */
  picovoiceAccessKey?: string;
  /** Built-in Porcupine keyword to listen for. */
  keyword: string;
}
