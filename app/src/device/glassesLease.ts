import { useEffect } from 'react';
import { createLogger } from '../core/Logger';
import { ErrorCode } from '../core/errors';
import { MWDATNative, mwdatAvailable } from '../native/MWDATNative';

const log = createLogger('glasses-lease');

/**
 * Who currently needs the glasses camera running.
 *
 * The glasses session used to be opened by ConnectScreen and then never closed:
 * `stopPreview()` existed on the bridge but was not called anywhere in the app,
 * so once the feed opened it stayed open for the whole life of the process. The
 * wearer's camera, the Bluetooth link and the H.264 writer kept running while
 * the user browsed the Library, watched a clip, or sat in Settings.
 *
 * Mount is the wrong signal for this — React Navigation keeps every screen
 * below the top of the stack mounted, so ArmedScreen is still mounted while the
 * player sits on top of it. Screens take a lease on FOCUS and drop it on blur;
 * when the last one drops, the session is torn down.
 */
let holders = 0;
let pendingRelease: ReturnType<typeof setTimeout> | null = null;

/**
 * Moving between two capture screens (`replace('Armed')`) blurs the outgoing
 * screen before the incoming one focuses, so the count dips through zero for a
 * frame. Tearing down there would cost a full session renegotiation — ~2s of
 * `waitingForDevice` -> `starting` -> `streaming` — just to reopen what we
 * already had. Wait out the gap before believing a release.
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
    log.debug('last holder released — closing glasses session');
    MWDATNative.stopPreview().catch(err =>
      log.error(
        'could not close the glasses session',
        err,
        ErrorCode.GlassesTeardownFailed,
      ),
    );
  }, RELEASE_GRACE_MS);
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
