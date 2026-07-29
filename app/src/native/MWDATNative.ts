import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

/**
 * Native bridge to the Meta Wearables Device Access Toolkit (iOS: Swift
 * bridge in ios/Jarvis/MWDATBridge.swift; Android bridge lands later).
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

interface MWDATBridgeModule {
  getRegistrationState(): Promise<string>;
  startRegistration(): Promise<string>;
  getDiagnostics(): Promise<MWDATDiagnostics>;
  mockEnable(): Promise<void>;
  prepare(): Promise<void>;
  startPreview(): Promise<void>;
  stopPreview(): Promise<void>;
  start(segmentSeconds: number): Promise<void>;
  cut(): Promise<void>;
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
  start: (segmentSeconds: number) => requireNative().start(segmentSeconds),
  cut: () => requireNative().cut(),
  stop: () => requireNative().stop(),
};

export function mwdatEvents(): NativeEventEmitter {
  requireNative();
  return new NativeEventEmitter(NativeModules.MWDATBridge);
}
