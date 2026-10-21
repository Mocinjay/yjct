import { Alert } from 'react-native';
import Share from 'react-native-share';
import { deliverablePath } from '../core/ClipStore';
import type { Clip } from '../types';

/**
 * Opens the OS share sheet for a clip: the free-tier way out, the same
 * mechanism as sharing a Camera Roll video (no platform API involved). It
 * shares the captioned cut once one exists, since that is the version the
 * wearer means to send. Failures are shown, never swallowed.
 */
export async function shareClip(clip: Clip): Promise<void> {
  try {
    await Share.open({
      url: `file://${deliverablePath(clip)}`,
      type: 'video/mp4',
      failOnCancel: false,
    });
  } catch (e) {
    Alert.alert('Share failed', e instanceof Error ? e.message : String(e));
  }
}
