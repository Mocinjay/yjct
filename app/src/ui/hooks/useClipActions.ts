import { useMemo } from 'react';
import { captionQueue } from '../../captioning/CaptionQueue';
import { clipStore } from '../../core/ClipStore';
import { createLogger } from '../../core/Logger';
import { ErrorCode } from '../../core/errors';

const log = createLogger('library');

export interface UseClipActions {
  /** Keep this clip forever: clears the expiry clock. */
  save: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  markPublished: (id: string, platform: string) => Promise<void>;
  /** Re-run captioning in place — how a restyle is applied. */
  recaption: (id: string) => Promise<void>;
}

/**
 * Mutations on a clip.
 *
 * These were called straight from screens, which meant every screen had its own
 * idea of what to do when one failed — mostly nothing, silently. Deleting a
 * clip that could not actually be deleted still dismissed the player.
 *
 * Failures are logged and swallowed deliberately: the library re-reads from the
 * store on every change, so a failed write leaves the UI showing the truth
 * rather than an optimistic lie.
 */
export function useClipActions(): UseClipActions {
  return useMemo(
    () => ({
      save: async id => {
        try {
          await clipStore.save(id);
        } catch (err) {
          log.error('could not save clip', err, ErrorCode.StorageWriteFailed);
        }
      },
      rename: async (id, name) => {
        try {
          await clipStore.rename(id, name);
        } catch (err) {
          log.error('could not rename clip', err, ErrorCode.StorageWriteFailed);
        }
      },
      remove: async id => {
        try {
          await clipStore.remove(id);
        } catch (err) {
          log.error('could not delete clip', err, ErrorCode.StorageDeleteFailed);
        }
      },
      markPublished: async (id, platform) => {
        try {
          await clipStore.markPublished(id, platform);
        } catch (err) {
          log.error('could not record the publish', err, ErrorCode.StorageWriteFailed);
        }
      },
      recaption: async id => {
        try {
          await captionQueue.retry(id);
        } catch (err) {
          log.error('could not queue a recaption', err, ErrorCode.CaptionJobFailed);
        }
      },
    }),
    [],
  );
}
