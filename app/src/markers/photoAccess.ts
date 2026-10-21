import type { PhotoAccessStatus } from '../native/GlassesMediaLibraryNative';

/**
 * Why the full-resolution import cannot run, in words the wearer can act on,
 * or null when it can. Only full access returns null. "Selected Photos" is the
 * dangerous case: every call succeeds and the scan finds nothing, forever,
 * because Meta AI's syncs are never part of a hand-made selection.
 */
export function photoAccessBlocker(status: PhotoAccessStatus): string | null {
  switch (status) {
    case 'authorized':
      return null;
    case 'limited':
      return (
        'Clypso can’t see your glasses recordings while Photos is set to ' +
        'Selected Photos. Meta AI syncs them in on its own, so they’re never ' +
        'part of a selection you made by hand. Settings → Privacy & Security → ' +
        'Photos → Clypso → All Photos.'
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
