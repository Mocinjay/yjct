import { settingsStore } from '../core/SettingsStore';
import { captionEngineUsable } from '../native/CaptionEngineNative';
import { connectorConfigStore } from '../core/ConnectorConfig';
import type { CaptioningProvider } from './CaptioningProvider';
import { HttpCaptioningProvider } from './HttpCaptioningProvider';
import { MockCaptioningProvider } from './MockCaptioningProvider';
import { OnDeviceCaptioningProvider } from './OnDeviceCaptioningProvider';

/**
 * Picks the captioning implementation for this device, best first:
 *
 *  1. on-device (iOS) — no server, no key, audio never leaves the device
 *  2. the self-hosted HTTP service — Android, or iOS where on-device
 *     recognition is unavailable for the locale
 *  3. the mock — dev only, and it labels itself as such
 *
 * This lived on `PublishService`, which made the captioning queue import the
 * publishing service purely to ask which captioner to use — publishing and
 * captioning each depending on the other for no reason beyond where the
 * function happened to sit. Choosing a captioner is captioning's business.
 */
export async function resolveCaptioner(): Promise<CaptioningProvider> {
  if (await captionEngineUsable()) {
    const { climaxEdit } = await settingsStore.get();
    return new OnDeviceCaptioningProvider(climaxEdit);
  }
  const cfg = await connectorConfigStore.get();
  return cfg.captioningUrl
    ? new HttpCaptioningProvider(cfg.captioningUrl)
    : new MockCaptioningProvider();
}
