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
import { closeGlassesIfUnleased } from './glassesLease';

/**
 * Meta Wearables Device Access Toolkit source — Ray-Ban / Oakley Meta glasses
 * camera session via the native MWDATBridge (ios/Clypso/MWDATBridge.swift).
 *
 * The native side opens a wearables session, streams glasses video, muxes in
 * phone-mic audio (the glasses' Bluetooth mic shares the camera link and would
 * starve it; see MWDATSegmentWriter), and reports fixed-length segment files. This is the only source the app uses; tests drive the capture
 * loop with fakes behind the same DeviceVideoSource contract.
 *
 * Requires one-time registration with the Meta AI app (Settings → “Connect
 * Meta glasses”) and Developer Mode in Meta AI during the developer preview.
 */
export class MWDATSource implements DeviceVideoSource {
  readonly kind = 'mwdat' as const;

  private subscriptions: EmitterSubscription[] = [];

  /** Rejects with the platform's own reason when the native bridge is missing. */
  async prepare(): Promise<void> {
    await MWDATNative.prepare();
  }

  async start(
    onSegment: (segment: Segment) => void,
    onError: (e: Error) => void,
  ): Promise<void> {
    // Re-arming from the error state calls start() again without stop(); drop
    // the previous listeners so each segment is delivered exactly once (twice
    // would put the same footage in the buffer, and in the clip, twice).
    this.clearSubscriptions();
    const emitter = mwdatEvents();
    const subscriptions = [
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
    this.subscriptions = subscriptions;
    try {
      await MWDATNative.start(SEGMENT_SECONDS);
    } catch (e) {
      // Only while they are still this call's: a superseded start that fails
      // late must not strip the listeners a newer start attached (whatever
      // replaced ours already removed them).
      if (this.subscriptions === subscriptions) {
        this.clearSubscriptions();
      }
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
      // Soft stop: detach the segment writer but keep the glasses stream, so a
      // re-arm does not renegotiate the link (which plays the glasses' stop and
      // start chimes).
      await MWDATNative.stopRecording();
    } catch {
      // native side already torn down
    }
    // The stream is kept for a quick re-arm, but only while a screen still
    // holds it.
    closeGlassesIfUnleased();
  }

  private clearSubscriptions(): void {
    this.subscriptions.forEach(sub => sub.remove());
    this.subscriptions = [];
  }
}
