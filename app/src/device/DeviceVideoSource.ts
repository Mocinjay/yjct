import type { DeviceKind, Segment } from '../types';

/**
 * A source of rolling video segments. Implementations record fixed-length
 * segments back-to-back while armed and hand each finished segment to
 * `onSegment`. The capture pipeline is source-agnostic: the mock (phone
 * camera) and the real glasses (MWDAT) plug in behind this same contract.
 */
export interface DeviceVideoSource {
  readonly kind: DeviceKind;

  /** Request permissions / open the device session. */
  prepare(): Promise<void>;

  /**
   * Start the continuous segment loop. Each finished segment file is
   * reported via `onSegment`. Runs until `stop()`.
   */
  start(onSegment: (segment: Segment) => void, onError: (e: Error) => void): Promise<void>;

  /**
   * Finalize the in-flight segment immediately (trigger fired). Resolves
   * once the segment has been delivered to `onSegment`. The loop keeps
   * running afterwards unless `stop()` is called.
   */
  cut(): Promise<void>;

  /** Stop the loop and close the session. In-flight segment is discarded. */
  stop(): Promise<void>;
}
