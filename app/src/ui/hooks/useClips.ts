import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { clipStore } from '../../core/ClipStore';
import { createLogger } from '../../core/Logger';
import { ErrorCode } from '../../core/errors';
import type { Clip } from '../../types';

const log = createLogger('library');

export interface UseClips {
  clips: Clip[];
  /** How many clips the last sweep reclaimed, so the UI can explain the gap. */
  expiredCount: number;
  /** Acknowledge the expiry notice. */
  dismissExpiredNotice: () => void;
  reload: () => void;
}

export interface UseClipsOptions {
  /**
   * Run the retention sweep whenever this screen gains focus.
   *
   * iOS gives no dependable background execution, so an expired clip outlives
   * its deadline until the app is next opened. Only the library wants this —
   * sweeping from the player could delete the clip being watched.
   */
  sweepOnFocus?: boolean;
}

/**
 * The clip library, kept in sync with the store.
 *
 * Three screens each re-implemented `list()` plus `subscribe()`, and the store
 * notifies without payload, so each also had to remember to re-read.
 */
export function useClips(options: UseClipsOptions = {}): UseClips {
  const { sweepOnFocus = false } = options;
  const [clips, setClips] = useState<Clip[]>([]);
  const [expiredCount, setExpiredCount] = useState(0);

  const reload = useCallback(() => {
    clipStore
      .list()
      .then(setClips)
      .catch(err =>
        log.error('could not read the clip library', err, ErrorCode.StorageIndexUnreadable),
      );
  }, []);

  useEffect(() => {
    reload();
    return clipStore.subscribe(reload);
  }, [reload]);

  useFocusEffect(
    useCallback(() => {
      if (!sweepOnFocus) {
        return;
      }
      clipStore
        .sweepExpired()
        .then(expired => {
          if (expired.length > 0) {
            setExpiredCount(expired.length);
          }
          reload();
        })
        .catch(err =>
          log.error('expiry sweep failed', err, ErrorCode.StorageSweepFailed),
        );
    }, [sweepOnFocus, reload]),
  );

  const dismissExpiredNotice = useCallback(() => setExpiredCount(0), []);

  return { clips, expiredCount, dismissExpiredNotice, reload };
}

/**
 * One clip, tracked live.
 *
 * The route param is a snapshot from the moment a card was tapped, and a
 * captioning job for that clip may still be running — so the player has to read
 * the store's copy rather than the one it was handed.
 */
export function useClip(id: string): Clip | null {
  const { clips } = useClips();
  return useMemo(() => clips.find(c => c.id === id) ?? null, [clips, id]);
}
