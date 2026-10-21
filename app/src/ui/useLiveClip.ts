import { useEffect, useState } from 'react';
import { clipStore } from '../core/ClipStore';
import type { Clip } from '../types';

/**
 * The store's current copy of a clip that was handed over as a route param.
 *
 * The param is a snapshot from the moment the clip was opened, while
 * captioning, renames and publishing keep changing the stored copy as the
 * screen stays up. If the clip is deleted, the last copy seen is kept.
 */
export function useLiveClip(opened: Clip): Clip {
  const [clip, setClip] = useState(opened);
  useEffect(() => {
    const sync = () =>
      clipStore.list().then(all => {
        const live = all.find(c => c.id === opened.id);
        if (live) {
          setClip(live);
        }
      });
    sync();
    return clipStore.subscribe(sync);
  }, [opened.id]);
  return clip;
}
