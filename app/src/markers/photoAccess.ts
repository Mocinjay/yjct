/**
 * Whether the library can be read, in words the wearer can act on.
 *
 * Pulled out of the service and the screen because it is the one decision this
 * feature cannot afford to get wrong. "Selected Photos" is the dangerous case:
 * every API call succeeds, the scan runs, and it finds nothing — forever —
 * because a recording Meta AI syncs in was never in a selection made by hand.
 * An app that leaves the switch on in that state is claiming to be listening
 * when it is not.
 */

import type { PhotoAccessStatus } from '../native/GlassesMediaLibraryNative';

/**
 * Why importing cannot run, or null when it can.
 *
 * Only full access returns null. `undetermined` is included deliberately: it
 * means the wearer has not been asked yet, which is not a state anything should
 * be started in.
 */
export function photoAccessBlocker(status: PhotoAccessStatus): string | null {
  switch (status) {
    case 'authorized':
      return null;
    case 'limited':
      return (
        'Clypso can’t see your glasses recordings while Photos is set to ' +
        'Selected Photos. Meta AI syncs them in on its own, so they’re never ' +
        'part of a selection you made by hand — picking more photos won’t ' +
        'help. Settings → Privacy & Security → Photos → Clypso → All Photos.'
      );
    case 'denied':
      return (
        'Clypso needs access to your photo library to find what your glasses ' +
        'recorded. Settings → Privacy & Security → Photos → Clypso → All Photos.'
      );
    case 'restricted':
      return (
        'Photo library access is blocked on this phone, so Clypso can’t reach ' +
        'your glasses recordings. Check Screen Time restrictions.'
      );
    case 'undetermined':
      return 'Clypso hasn’t been given access to your photo library yet.';
  }
}
