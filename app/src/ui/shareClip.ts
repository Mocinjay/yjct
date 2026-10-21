import { Alert } from 'react-native';
import Share from 'react-native-share';
import { deliverablePath, isPublishable } from '../core/ClipStore';
import { describe } from '../core/errors';
import type { Clip } from '../types';

/**
 * Free-tier sharing: the native OS share sheet, the same mechanism as sharing a
 * Camera Roll video — not an API integration. `deliverablePath` is what makes it
 * send the captioned cut once one exists.
 */
export async function shareClip(clip: Clip): Promise<void> {
  if (!isPublishable(clip)) {
    Alert.alert(
      'Master not ready',
      'This moment is marked. Share unlocks after Meta syncs the ≥1080p master into Photos.',
    );
    return;
  }
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
