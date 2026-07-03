/**
 * On-device wake-word detection against the app's own mic stream.
 *
 * There is deliberately NO cloud implementation and NO Meta AI / "Hey Meta"
 * integration — that hook does not exist for third parties. Detection must
 * be low-latency and low-battery, i.e. fully on-device.
 */
export interface WakeWordProvider {
  readonly name: string;

  /** Begin listening; invoke `onDetected` every time the phrase is heard. */
  start(onDetected: () => void): Promise<void>;

  stop(): Promise<void>;
}
