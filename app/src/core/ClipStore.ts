import RNFS from 'react-native-fs';
import type { Clip } from '../types';

const CLIPS_DIR = `${RNFS.DocumentDirectoryPath}/clips`;
const INDEX_PATH = `${CLIPS_DIR}/index.json`;
/**
 * Previous index, kept so a crash mid-write can never lose the whole library.
 * RNFS has no atomic replace, so a write moves the live index aside before
 * moving the new one in; if the app dies in that window, this file is the
 * recovery point and `list()` falls back to it.
 */
const BACKUP_PATH = `${CLIPS_DIR}/index.bak.json`;

/**
 * Local clip library: MP4s + thumbnails under Documents/clips, with a JSON
 * index.
 *
 * Clips are temporary by default. A free-tier clip carries an `expiresAt`
 * and is wiped by `sweepExpired()` unless the wearer saves or publishes it
 * first. Pro clips are created with `expiresAt: null` and are kept forever.
 *
 * Every change goes through `mutate()`, and index writes are queued one at a
 * time. Captioning progress, UI edits and the launch sweep all write here
 * concurrently, so neither rule is optional.
 */
export class ClipStore {
  private clips: Clip[] | null = null;
  /** The first read of the index, shared so concurrent callers parse it once. */
  private loading: Promise<Clip[]> | null = null;
  /**
   * Tail of the index-write queue. A write is several native calls, and two
   * interleaved ones collide on the temp and backup files (iOS will not move
   * onto an existing file), so writes run one at a time.
   */
  private writes: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();

  async ensureDir(): Promise<string> {
    await RNFS.mkdir(CLIPS_DIR);
    return CLIPS_DIR;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async list(): Promise<Clip[]> {
    if (this.clips) {
      return this.clips;
    }
    // Concurrent first callers share one read. If each parsed its own copy,
    // the last read to land would overwrite changes made off the first (e.g.
    // bring back a clip the launch sweep had just deleted).
    if (!this.loading) {
      const load: Promise<Clip[]> = this.ensureDir()
        .then(readIndex)
        .then(clips => {
          this.clips = this.clips ?? clips;
          return this.clips;
        })
        .finally(() => {
          // Only its own: a resetCache() may have started a newer load.
          if (this.loading === load) {
            this.loading = null;
          }
        });
      this.loading = load;
    }
    return this.loading;
  }

  async add(clip: Clip): Promise<void> {
    await this.mutate(clips => [clip, ...clips]);
  }

  async rename(id: string, name: string): Promise<void> {
    await this.mutate(clips => clips.map(c => (c.id === id ? { ...c, name } : c)));
  }

  /** Keep this clip forever: clears the expiry clock. */
  async save(id: string): Promise<void> {
    await this.mutate(clips =>
      clips.map(c =>
        c.id === id ? { ...c, savedAt: c.savedAt ?? Date.now(), expiresAt: null } : c,
      ),
    );
  }

  /**
   * Updates a clip's captioning progress. Kept in the index rather than in
   * memory so a job interrupted by the app being killed is still visible as
   * unfinished on the next launch, and CaptionQueue can pick it back up.
   */
  async setCaptionState(id: string, patch: CaptionPatch): Promise<void> {
    await this.mutate(clips =>
      // A clip deleted or swept while its job ran stays gone.
      clips.some(c => c.id === id)
        ? clips.map(c => (c.id === id ? { ...c, ...patch } : c))
        : clips,
    );
  }

  /**
   * Records a successful publish. Publishing is an implicit save — a clip the
   * user put on YouTube must not evaporate 24h later.
   */
  async markPublished(id: string, platform: string): Promise<void> {
    await this.mutate(clips =>
      clips.map(c => {
        if (c.id !== id) {
          return c;
        }
        const publishedTo = c.publishedTo ?? [];
        return {
          ...c,
          publishedTo: publishedTo.includes(platform)
            ? publishedTo
            : [...publishedTo, platform],
          savedAt: c.savedAt ?? Date.now(),
          expiresAt: null,
        };
      }),
    );
  }

  /**
   * Clears the clock on every pending clip. Called when Pro activates, so
   * upgrading rescues whatever was about to expire.
   *
   * The reverse is deliberately not implemented: losing Pro leaves existing
   * clips alone and only newly captured ones get a clock again.
   */
  async rescueExpiring(): Promise<number> {
    let rescued = 0;
    const now = Date.now();
    await this.mutate(clips => {
      rescued = clips.filter(isPending).length;
      return rescued === 0
        ? clips
        : clips.map(c =>
            isPending(c) ? { ...c, savedAt: c.savedAt ?? now, expiresAt: null } : c,
          );
    });
    return rescued;
  }

  /**
   * Deletes every clip whose clock has run out, along with its files.
   * Returns what was removed so the UI can tell the user rather than having
   * clips vanish silently.
   */
  async sweepExpired(now = Date.now()): Promise<Clip[]> {
    let expired: Clip[] = [];
    await this.mutate(clips => {
      expired = clips.filter(c => c.expiresAt !== null && c.expiresAt <= now);
      return expired.length === 0 ? clips : clips.filter(c => !expired.includes(c));
    });
    for (const clip of expired) {
      await deleteClipFiles(clip);
    }
    return expired;
  }

  /** Deletes a clip and its files. An unknown id is a no-op. */
  async remove(id: string): Promise<void> {
    let removed: Clip | undefined;
    await this.mutate(clips => {
      removed = clips.find(c => c.id === id);
      return removed ? clips.filter(c => c !== removed) : clips;
    });
    if (removed) {
      await deleteClipFiles(removed);
    }
  }

  /** Test seam — drops the in-memory cache so the next list() re-reads disk. */
  resetCache(): void {
    this.clips = null;
    this.loading = null;
  }

  /**
   * Applies `change` to the current list and saves the result. The change
   * runs synchronously against the list as it is once any pending load has
   * finished, never against a snapshot taken before an await, so concurrent
   * mutations compose instead of overwriting each other. Returning the same
   * array means nothing changed: no write, no notification.
   */
  private async mutate(change: (clips: Clip[]) => Clip[]): Promise<void> {
    await this.list();
    const current = this.clips ?? [];
    const next = change(current);
    if (next === current) {
      return;
    }
    this.clips = next;
    await this.persist();
  }

  /**
   * Queues a write of the in-memory list behind any write in progress. The
   * list is serialized when the write starts, so the last write queued always
   * saves the newest state. A failed write rejects only its own caller.
   */
  private persist(): Promise<void> {
    const write = this.writes.then(() => this.writeIndex());
    this.writes = write.catch(() => {});
    return write;
  }

  private async writeIndex(): Promise<void> {
    const tmp = `${INDEX_PATH}.tmp`;
    await RNFS.writeFile(tmp, JSON.stringify(this.clips ?? []), 'utf8');
    // Move the live index aside rather than deleting it, so there is never a
    // moment with no index on disk for a kill to land in.
    if (await exists(INDEX_PATH)) {
      await deleteIfExists(BACKUP_PATH);
      await RNFS.moveFile(INDEX_PATH, BACKUP_PATH);
    }
    await RNFS.moveFile(tmp, INDEX_PATH);
    this.listeners.forEach(l => l());
  }
}

/** The caption fields, which are the only thing setCaptionState may touch. */
export type CaptionPatch = Partial<
  Pick<
    Clip,
    | 'captionState'
    | 'captionedFilePath'
    | 'captionStyle'
    | 'captionProvider'
    | 'captionError'
  >
>;

/** True while a clip is still temporary and counting down. */
export function isPending(clip: Clip): boolean {
  return clip.expiresAt !== null;
}

/**
 * The file to play, share, and publish: the captioned cut once it exists,
 * the raw capture until then. Everything user-facing goes through this so a
 * clip is never shared uncaptioned just because one screen forgot.
 */
export function deliverablePath(clip: Clip): string {
  return clip.captionState === 'ready' && clip.captionedFilePath
    ? clip.captionedFilePath
    : clip.filePath;
}

/** True when the clip has a real captioned cut (mock-provider output does not count). */
export function hasBurnedCaptions(clip: Clip): boolean {
  return (
    clip.captionState === 'ready' &&
    Boolean(clip.captionedFilePath) &&
    clip.captionProvider !== 'mock'
  );
}

/** True while the clip is waiting on, or inside, the captioning pipeline. */
export function isCaptioning(clip: Clip): boolean {
  return clip.captionState === 'queued' || clip.captionState === 'processing';
}

/** Milliseconds until wipe, or null if the clip is kept forever. */
export function msUntilExpiry(clip: Clip, now = Date.now()): number | null {
  return clip.expiresAt === null ? null : clip.expiresAt - now;
}

async function readIndex(): Promise<Clip[]> {
  for (const path of [INDEX_PATH, BACKUP_PATH]) {
    try {
      const raw = await RNFS.readFile(path, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeClip);
      }
    } catch {
      // missing or corrupt — fall through to the backup, then to empty
    }
  }
  return [];
}

/**
 * Clips written before retention existed have neither field. They predate the
 * 24h rule, so they are treated as saved — upgrading the app must never
 * retroactively schedule someone's existing library for deletion.
 */
function normalizeClip(raw: Clip): Clip {
  const legacy = raw.expiresAt === undefined && raw.savedAt === undefined;
  return {
    ...raw,
    savedAt: legacy ? raw.capturedAt : raw.savedAt ?? null,
    expiresAt: legacy ? null : raw.expiresAt ?? null,
    // Clips captured before auto-captioning existed are not retroactively
    // queued — they show as uncaptioned until the wearer asks.
    captionState: raw.captionState ?? 'none',
  };
}

async function deleteClipFiles(clip: Clip): Promise<void> {
  await deleteIfExists(clip.filePath);
  await deleteIfExists(clip.thumbnailPath);
  if (clip.captionedFilePath) {
    await deleteIfExists(clip.captionedFilePath);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    return await RNFS.exists(path);
  } catch {
    return false;
  }
}

async function deleteIfExists(path: string): Promise<void> {
  try {
    await RNFS.unlink(path);
  } catch {
    // already gone
  }
}

export const clipStore = new ClipStore();
