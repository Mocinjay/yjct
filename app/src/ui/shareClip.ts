import { Alert } from 'react-native';
import Share from 'react-native-share';
import { deliverablePath } from '../core/ClipStore';
import { describe } from '../core/errors';
import type { Clip } from '../types';

/**
 * Free-tier sharing: the native OS share sheet, the same mechanism as sharing a
 * Camera Roll video — not an API integration. `deliverablePath` is what makes it
 * send the captioned cut once one exists.
 */
export async function shareClip(clip: Clip): Promise<void> {
  try {
    await Share.open({
      url: `file://${deliverablePath(clip)}`,
      type: 'video/mp4',
      failOnCancel: false,
    });
  } catch (err) {
    Alert.alert('Share failed', describe(err));
  }
}
