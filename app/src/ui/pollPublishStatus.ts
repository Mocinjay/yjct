import type { PublishStatus } from '../phase2/PublishTarget';

export const PUBLISH_POLL_INTERVAL_MS = 2000;

/**
 * Polls a publish until the platform reports a final state ('published' or
 * 'failed'), handing every status to `onStatus`. 'pending' and 'processing'
 * keep it going.
 *
 * - Each check starts only after the previous one settles, so a slow platform
 *   never has requests stacked up behind it.
 * - A check that throws counts as 'failed' with its message, which is what
 *   the targets themselves return for a status error.
 * - `isActive` is asked before every check and before reporting, so once the
 *   screen is gone nothing more is fetched or reported (Facebook can stay
 *   'processing' indefinitely).
 */
export async function pollPublishStatus(
  check: () => Promise<PublishStatus>,
  onStatus: (status: PublishStatus) => void,
  isActive: () => boolean,
  intervalMs = PUBLISH_POLL_INTERVAL_MS,
): Promise<void> {
  while (isActive()) {
    let status: PublishStatus;
    try {
      status = await check();
    } catch (err) {
      status = {
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!isActive()) {
      return;
    }
    onStatus(status);
    if (status.state === 'published' || status.state === 'failed') {
      return;
    }
    await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
  }
}
