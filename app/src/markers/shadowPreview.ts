import { NativeEventEmitter, NativeModules } from 'react-native';
import RNFS from 'react-native-fs';
import { createLogger } from '../core/Logger';
import { ErrorCode } from '../core/errors';
import { mwdatAvailable } from '../native/MWDATNative';

const log = createLogger('shadow-preview');

/**
 * Last JPEG from the DAT preview stream (if any).
 *
 * Shadow Proxy uses this as the library poster the instant "Clypso" is heard —
 * UI feedback only. It is never the deliverable video (Quality non-negotiable).
 */
let lastBase64: string | null = null;
let subscribed = false;

export function notePreviewFrame(base64: string): void {
  if (base64) {
    lastBase64 = base64;
  }
}

/** Start caching preview frames if the MWDAT bridge is present. */
export function ensurePreviewFrameCache(): void {
  if (subscribed) {
    return;
  }
  try {
    if (!mwdatAvailable()) {
      return;
    }
  } catch {
    return;
  }
  subscribed = true;
  const emitter = new NativeEventEmitter(NativeModules.MWDATBridge);
  emitter.addListener('MWDATPreviewFrame', (e: { base64?: string }) => {
    if (e?.base64) {
      lastBase64 = e.base64;
    }
  });
}

/**
 * Write the latest stream still to disk for a shadow card thumbnail.
 * Returns empty string when no frame has been seen (still card is fine).
 */
export async function writeShadowThumbnail(destPath: string): Promise<string> {
  if (!lastBase64) {
    return '';
  }
  try {
    await RNFS.writeFile(destPath, lastBase64, 'base64');
    return destPath;
  } catch (err) {
    log.expected(
      'could not write shadow thumbnail',
      err,
      ErrorCode.StorageWriteFailed,
    );
    return '';
  }
}
