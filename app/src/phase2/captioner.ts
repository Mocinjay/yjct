import { settingsStore } from '../core/SettingsStore';
import { captionEngineUsable } from '../native/CaptionEngineNative';
import type { CaptioningProvider } from './CaptioningProvider';
import { connectorConfigStore } from './ConnectorConfig';
import { HttpCaptioningProvider } from './HttpCaptioningProvider';
import { MockCaptioningProvider } from './MockCaptioningProvider';
import { OnDeviceCaptioningProvider } from './OnDeviceCaptioningProvider';

/**
 * Picks the captioner for the next job. CaptionQueue calls this per job, so a
 * Settings change (hook-first edit, captioning URL) applies from the next clip
 * on. Order matters:
 *
 *  1. on-device (iOS) — no server, no key, audio never leaves the device
 *  2. the self-hosted HTTP service — Android, or iOS when on-device
 *     recognition is unavailable (no Speech permission, or no offline
 *     dictation for the language)
 *  3. the mock — dev builds only. It copies the clip untouched, so in a
 *     release build it would only double each clip on disk for a fake result;
 *     there the job fails with a reason the player shows instead.
 */
export async function getCaptioner(): Promise<CaptioningProvider> {
  if (await captionEngineUsable()) {
    const { climaxEdit } = await settingsStore.get();
    return new OnDeviceCaptioningProvider(climaxEdit);
  }
  const { captioningUrl } = await connectorConfigStore.get();
  if (captioningUrl) {
    return new HttpCaptioningProvider(captioningUrl);
  }
  if (__DEV__) {
    return new MockCaptioningProvider();
  }
  throw new Error(
    'On-device captioning is unavailable (Speech Recognition permission or ' +
      'offline dictation for your language) and no captioning service URL is ' +
      'set in Settings → Connections.',
  );
}
