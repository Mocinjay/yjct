import { NativeModules, Platform } from 'react-native';

/**
 * Lock Screen / Dynamic Island "LIVE" activity.
 *
 * Exists so the wearer can leave the app — the normal case, phone pocketed —
 * and still see that Clypso is armed and how many clips have landed.
 *
 * Every call is best-effort: the activity is a convenience, and nothing about
 * capture should fail because the OS declined to show it (too old, disabled in
 * Settings, or over ActivityKit's update budget).
 */
interface LiveActivityNative {
  isSupported(): Promise<boolean>;
  start(deviceName: string): Promise<boolean>;
  update(
    bufferedSeconds: number,
    clipCount: number,
    recording: boolean,
    /** Epoch ms, or 0 when not recording. */
    recordingSince: number,
  ): Promise<boolean>;
  end(): Promise<boolean>;
}

const native: LiveActivityNative | undefined =
  Platform.OS === 'ios' ? NativeModules.LiveActivityBridge : undefined;

export function liveActivityAvailable(): boolean {
  return native != null;
}

export const LiveActivity = {
  isSupported: (): Promise<boolean> =>
    native?.isSupported().catch(() => false) ?? Promise.resolve(false),

  start: (deviceName: string): Promise<boolean> =>
    native?.start(deviceName).catch(() => false) ?? Promise.resolve(false),

  update: (
    bufferedSeconds: number,
    clipCount: number,
    recording: boolean,
    recordingSince: number,
  ): Promise<boolean> =>
    native
      ?.update(Math.round(bufferedSeconds), clipCount, recording, recordingSince)
      .catch(() => false) ?? Promise.resolve(false),

  end: (): Promise<boolean> =>
    native?.end().catch(() => false) ?? Promise.resolve(false),
};
