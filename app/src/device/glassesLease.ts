import { useEffect } from 'react';
import { MWDATNative, mwdatAvailable } from '../native/MWDATNative';

/**
 * Reference count of the screens that need the glasses camera running.
 *
 * Screens acquire on FOCUS and release on blur, not on mount, because React
 * Navigation keeps covered screens mounted (ArmedScreen stays mounted under the
 * Library and the player). When the count stays at zero past a short grace
 * period, the session is closed so the camera, the Bluetooth link and the
 * encoder do not run while nothing needs them.
 *
 * A release that lands while recording cannot close anything (`stopPreview()`
 * never kills a recording); MWDATSource.stop() calls `closeGlassesIfUnleased()`
 * once recording ends.
 */
let holders = 0;
let pendingRelease: ReturnType<typeof setTimeout> | null = null;

/**
 * The Connect → Armed `navigation.reset` drops Connect's lease before Armed
 * takes one, so the count dips through zero for a moment. Tearing down there
 * would cost a full session renegotiation (~2s of `waitingForDevice` ->
 * `starting` -> `streaming`) to reopen what is already open, so a release only
 * takes effect once this grace period passes with no new holder.
 */
const RELEASE_GRACE_MS = 750;

function acquire(): void {
  holders += 1;
  if (pendingRelease) {
    clearTimeout(pendingRelease);
    pendingRelease = null;
  }
}

function release(): void {
  holders = Math.max(0, holders - 1);
  if (holders > 0 || pendingRelease) {
    return;
  }
  pendingRelease = setTimeout(() => {
    pendingRelease = null;
    if (holders > 0) {
      return;
    }
    // `stopPreview()` is deliberately a no-op while a writer is attached, so a
    // manual extended recording in progress can never be killed by navigation.
    // MWDATSource.stop() closes the session once that recording ends.
    MWDATNative.stopPreview().catch(() => {});
  }, RELEASE_GRACE_MS);
}

/**
 * Closes the glasses session if no screen holds a lease and no release is
 * still in its grace period (that timer closes it instead). Called when
 * recording stops, because a release that landed while the writer was
 * attached could not close anything.
 */
export function closeGlassesIfUnleased(): void {
  if (holders === 0 && !pendingRelease && mwdatAvailable()) {
    MWDATNative.stopPreview().catch(() => {});
  }
}

/**
 * Hold the glasses camera open while `active`, and release it when no screen
 * needs it any more.
 */
export function useGlassesLease(active: boolean): void {
  useEffect(() => {
    if (!mwdatAvailable() || !active) {
      return;
    }
    acquire();
    return release;
  }, [active]);
}
