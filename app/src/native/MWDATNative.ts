import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { StreamTimelineEntry } from '../markers/streamConcurrency';

/**
 * Native bridge to the Meta Wearables Device Access Toolkit (iOS: Swift
 * bridge in ios/Clypso/MWDATBridge.swift; Android bridge lands later).
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
  /**
   * Tears the Meta AI link down so it can be built again.
   *
   * The SDK's registration has a `registering` state it enters when Meta AI is
   * handed control and leaves only when the callback returns. An approval the
   * wearer abandoned parks it there, and every further `startRegistration()`
   * re-enters the pending request and comes back as Meta AI's own internal
   * error. This is the only way out.
   */
  unregister(): Promise<string>;
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
  /**
   * Sound the glasses' own capture tone as capture feedback. Resolves false
   * when there was no live stream to play it on. See MWDATBridge.swift — the
   * SDK has no audio-output API, so this is a still capture used purely for
   * the firmware sound it makes.
   */
  chime(): Promise<boolean>;
  /** Stop the segment writer only — keeps the glasses camera stream alive. */
  stopRecording(): Promise<void>;
  /** Tear down the whole glasses session (stream + writer). */
  stop(): Promise<void>;
  /**
   * TEMPORARY: what the live stream was doing, second by second.
   *
   * Read by the import pass when a native recording turns up, to settle
   * whether the glasses can stream and record natively at once. In-memory and
   * session-scoped, so it only carries an answer when both halves happened
   * without an app restart in between. Remove with the probe.
   */
  getStreamTimeline(): Promise<{ entries: StreamTimelineEntry[] }>;
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
  unregister: () => requireNative().unregister(),
  getDiagnostics: () => requireNative().getDiagnostics(),
  mockEnable: () => requireNative().mockEnable(),
  prepare: () => requireNative().prepare(),
  startPreview: () => requireNative().startPreview(),
  stopPreview: () => requireNative().stopPreview(),
  setPreviewEnabled: (enabled: boolean) =>
    requireNative().setPreviewEnabled(enabled),
  start: (segmentSeconds: number) => requireNative().start(segmentSeconds),
  cut: () => requireNative().cut(),
  chime: () => requireNative().chime(),
  stopRecording: () => requireNative().stopRecording(),
  stop: () => requireNative().stop(),
  /**
   * Resolves to an empty timeline rather than throwing when the bridge is
   * absent. A diagnostic that can take down an import pass is worse than the
   * question it answers — and "no entries" is scored as no-evidence, which is
   * the honest reading of a bridge that was never there.
   */
  getStreamTimeline: async (): Promise<StreamTimelineEntry[]> => {
    if (!native) {
      return [];
    }
    const result = await native.getStreamTimeline();
    return result?.entries ?? [];
  },
};

export function mwdatEvents(): NativeEventEmitter {
  requireNative();
  return new NativeEventEmitter(NativeModules.MWDATBridge);
}
