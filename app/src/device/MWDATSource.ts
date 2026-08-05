import type { EmitterSubscription } from 'react-native';
import { SEGMENT_SECONDS } from '../config';
import type { Segment } from '../types';
import {
  MWDATNative,
  mwdatAvailable,
  mwdatEvents,
  type MWDATErrorEvent,
  type MWDATSegmentEvent,
} from '../native/MWDATNative';
import type { DeviceVideoSource } from './DeviceVideoSource';

/**
 * Meta Wearables Device Access Toolkit source — Ray-Ban / Oakley Meta glasses
 * camera session via the native MWDATBridge (ios/Clipso/MWDATBridge.swift).
 *
 * The native side opens a wearables session, streams glasses video, muxes in
 * mic audio (glasses Bluetooth mic while connected), and reports fixed-length
 * segment files — identical contract to MockDeviceSource.
 *
 * Requires one-time registration with the Meta AI app (Settings → “Connect
 * Meta glasses”) and Developer Mode in Meta AI during the developer preview.
 */
export class MWDATSource implements DeviceVideoSource {
  readonly kind = 'mwdat' as const;

  private subscriptions: EmitterSubscription[] = [];

  async prepare(): Promise<void> {
    if (!mwdatAvailable()) {
      throw new Error(
        'Meta glasses support is iOS-only for now. Switch the device to "Mock (phone camera)" in Settings.',
      );
    }
    await MWDATNative.prepare();
  }

  async start(
    onSegment: (segment: Segment) => void,
    onError: (e: Error) => void,
  ): Promise<void> {
    const emitter = mwdatEvents();
    this.subscriptions = [
      emitter.addListener('MWDATSegment', (event: MWDATSegmentEvent) => {
        onSegment({
          path: event.path,
          startedAt: event.startedAt,
          durationSec: event.durationSec,
        });
      }),
      emitter.addListener('MWDATError', (event: MWDATErrorEvent) => {
        onError(new Error(event.message));
      }),
    ];
    try {
      await MWDATNative.start(SEGMENT_SECONDS);
    } catch (e) {
      this.clearSubscriptions();
      throw e;
    }
  }

  async cut(): Promise<void> {
    await MWDATNative.cut();
  }

  async chime(): Promise<void> {
    if (!mwdatAvailable()) {
      return;
    }
    // Swallowed on purpose: the wearer losing the confirmation tone is a far
    // smaller failure than a capture that aborts because a sound did not play.
    await MWDATNative.chime().catch(() => false);
  }

  async stop(): Promise<void> {
    this.clearSubscriptions();
    try {
      // Soft stop: drop the rolling-buffer writer but keep the glasses stream.
      // A full session teardown here is what made the glasses play their stop
      // chime and refuse to re-arm when Live remounted or React cleaned up.
      await MWDATNative.stopRecording();
    } catch {
      // native side already torn down
    }
  }

  private clearSubscriptions(): void {
    this.subscriptions.forEach(sub => sub.remove());
    this.subscriptions = [];
  }
}
