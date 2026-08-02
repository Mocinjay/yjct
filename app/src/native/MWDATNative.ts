import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

/**
 * Native bridge to the Meta Wearables Device Access Toolkit (iOS: Swift
 * bridge in ios/Clipso/MWDATBridge.swift; Android bridge lands later).
 */
export interface MWDATSegmentEvent {
  path: string;
  startedAt: number;
  durationSec: number;
}

export interface MWDATErrorEvent {
  message: string;
}

export interface MWDATStateEvent {
  state: string;
  reason?: string;
}

export interface MWDATDeviceInfo {
  name: string;
  linkState: string;
  compatibility: string;
  type: string;
}

export interface MWDATDiagnostics {
  registration: string;
  devices: MWDATDeviceInfo[];
  streamState: string;
  recording: boolean;
  cameraPermission: string;
}

export interface MWDATPreviewFrameEvent {
  base64: string;
}

/**
 * Once-a-second report of what the glasses link is actually delivering. The
 * stream's own state machine can sit in `.streaming` over a dead link, so
 * frame arrival is the only signal that says whether the feed is alive.
 */
export interface MWDATStreamHealthEvent {
  fps: number;
  secondsSinceFrame: number;
  recording: boolean;
}

interface MWDATBridgeModule {
  getRegistrationState(): Promise<string>;
  startRegistration(): Promise<string>;
  getDiagnostics(): Promise<MWDATDiagnostics>;
  mockEnable(): Promise<void>;
  prepare(): Promise<void>;
  startPreview(): Promise<void>;
  stopPreview(): Promise<void>;
  /**
   * Gate preview-frame encoding without tearing down the glasses pipeline.
   * Encoding a frame costs a CoreImage render, a JPEG encode, a base64 encode
   * and a bridge crossing ~7x/second, so it must be off whenever nothing is
   * displaying the feed.
   */
  setPreviewEnabled(enabled: boolean): Promise<void>;
  start(segmentSeconds: number): Promise<void>;
  cut(): Promise<void>;
  /** Stop the segment writer only — keeps the glasses camera stream alive. */
  stopRecording(): Promise<void>;
  /** Tear down the whole glasses session (stream + writer). */
  stop(): Promise<void>;
}

const native: MWDATBridgeModule | undefined = NativeModules.MWDATBridge;

export function mwdatAvailable(): boolean {
  return Platform.OS === 'ios' && native != null;
}

/** True when running in the iOS Simulator (mock glasses auto-mode). */
export function mwdatIsSimulator(): boolean {
  return Boolean((NativeModules.MWDATBridge as any)?.isSimulator);
}

function requireNative(): MWDATBridgeModule {
  if (!native) {
    throw new Error(
      Platform.OS === 'ios'
        ? 'MWDATBridge native module missing — rebuild the iOS app.'
        : 'Meta glasses support is iOS-only for now.',
    );
  }
  return native;
}

export const MWDATNative = {
  getRegistrationState: () => requireNative().getRegistrationState(),
  startRegistration: () => requireNative().startRegistration(),
  getDiagnostics: () => requireNative().getDiagnostics(),
  mockEnable: () => requireNative().mockEnable(),
  prepare: () => requireNative().prepare(),
  startPreview: () => requireNative().startPreview(),
  stopPreview: () => requireNative().stopPreview(),
  setPreviewEnabled: (enabled: boolean) =>
    requireNative().setPreviewEnabled(enabled),
  start: (segmentSeconds: number) => requireNative().start(segmentSeconds),
  cut: () => requireNative().cut(),
  stopRecording: () => requireNative().stopRecording(),
  stop: () => requireNative().stop(),
};

export function mwdatEvents(): NativeEventEmitter {
  requireNative();
  return new NativeEventEmitter(NativeModules.MWDATBridge);
}
