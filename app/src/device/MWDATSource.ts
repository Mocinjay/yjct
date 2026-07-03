import type { Segment } from '../types';
import type { DeviceVideoSource } from './DeviceVideoSource';

/**
 * Meta Wearables Device Access Toolkit source — Ray-Ban Meta / Oakley Meta
 * HSTN / Ray-Ban Display camera+mic session.
 *
 * ⛔ Not implemented yet. This stub exists so the capture pipeline is
 * already coded against the right seam. The real implementation is a thin
 * native bridge (Swift/Kotlin) that opens an MWDAT streaming session and
 * writes fixed-length segments, then reports them here — identical contract
 * to MockDeviceSource.
 *
 * Do NOT fake glasses behavior here; use MockDeviceSource for testing.
 */
export class MWDATSource implements DeviceVideoSource {
  readonly kind = 'mwdat' as const;

  async prepare(): Promise<void> {
    throw new Error(
      'MWDAT bridge not yet integrated. Switch the device to "Mock (phone camera)" in Settings.',
    );
  }

  async start(
    _onSegment: (segment: Segment) => void,
    _onError: (e: Error) => void,
  ): Promise<void> {
    throw new Error('MWDAT bridge not yet integrated.');
  }

  async cut(): Promise<void> {
    throw new Error('MWDAT bridge not yet integrated.');
  }

  async stop(): Promise<void> {
    // nothing to close
  }
}
