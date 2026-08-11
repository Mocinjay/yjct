/**
 * On-device wake-word detection against the app's own mic stream.
 *
 * There is deliberately NO cloud implementation and NO Meta AI / "Hey Meta"
 * integration — that hook does not exist for third parties. Detection must
 * be low-latency and low-battery, i.e. fully on-device.
 */
/**
 * Where the trigger phrase landed, when the provider can tell.
 *
 * Detection from recorded segments trails the utterance by up to a whole
 * segment, so a clip that simply ends at the buffer boundary carries a
 * variable amount of dead air. With this the caller can end the clip on the
 * word instead.
 */
export interface WakeDetection {
  /** Segment file the phrase was heard in. */
  segmentPath: string;
  /** Seconds from the start of that segment to the end of the phrase. */
  endOffsetSec: number;
  /**
   * UNIX epoch milliseconds at which the phrase finished being spoken, when
   * the provider owns its own microphone and can stamp one.
   *
   * Offsets within a segment only mean something to whoever holds that
   * segment. An absolute time means something to a recording made somewhere
   * else entirely — which is what the glasses do when they capture to their
   * own storage with the phone uninvolved. This is the field that lets a
   * detection be found inside that footage afterwards.
   */
  atMs?: number;
}

export interface WakeWordProvider {
  readonly name: string;

  /**
   * Begin listening; invoke `onDetected` every time the phrase is heard.
   * The detection argument is omitted when the provider has no word timings
   * (live mic recognition, the manual mock trigger).
   */
  start(onDetected: (detection?: WakeDetection) => void): Promise<void>;

  stop(): Promise<void>;

  /**
   * Optional: providers that detect from recorded audio (rather than a live
   * mic stream) receive each rolling segment file as it lands.
   */
  feedSegment?(path: string): void;
}
