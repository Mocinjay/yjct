import RNFS from 'react-native-fs';
import { FREE_RETENTION_HOURS } from '../config';
import type { Clip } from '../types';
import { createLogger } from './Logger';
import { ErrorCode } from './errors';

const log = createLogger('library');

const CLIPS_DIR = `${RNFS.DocumentDirectoryPath}/clips`;
const INDEX_PATH = `${CLIPS_DIR}/index.json`;
/**
 * Previous index, kept so a crash mid-write can never lose the whole library.
 * RNFS has no atomic replace, so persist() moves the live index aside before
 * moving the new one in; if we die in that window, this file is the recovery
 * point and `list()` falls back to it.
 */
const BACKUP_PATH = `${CLIPS_DIR}/index.bak.json`;

/**
 * Local clip library: MP4s + thumbnails under Documents/clips, with a JSON
 * index.
 *
 * Clips are temporary by default. A free-tier clip carries an `expiresAt`
 * and is wiped by `sweepExpired()` unless the wearer saves or publishes it
 * first. Pro clips are created with `expiresAt: null` and are kept forever.
 */
export class ClipStore {
  private clips: Clip[] | null = null;
  private listeners = new Set<() => void>();
  /**
   * Serializes read-modify-write. Capture calls `add()` while CaptionQueue
   * calls `setCaptionState()` on its own schedule, so two mutations really do
   * overlap, and overlapping cost the store twice over:
   *
   * - **On disk:** both persists shared one `.tmp` path and both moved it. The
   *   second move found nothing there and rejected — *after* the live index had
   *   been moved aside, so the window with no index at all did not close.
   * - **In memory:** each mutator did `const clips = await this.list()` and then
   *   assigned a fresh array built from it. Two mutators reading the same base
   *   array meant the second assignment discarded the first's change, so a
   *   rename landing beside a caption update silently lost one of them.
   *
   * Both follow from the same gap, so both are closed in the same place:
   * `mutate()` reads, applies and writes as one turn.
   */
  private writeChain: Promise<void> = Promise.resolve();
  /** In-flight first read, so concurrent `list()` callers share one disk read. */
  private loading: Promise<Clip[]> | null = null;

  async ensureDir(): Promise<string> {
    await RNFS.mkdir(CLIPS_DIR);
    return CLIPS_DIR;
  }

  get dir(): string {
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
    // Every screen calls this on mount, so the first launch fires several at
    // once. Awaiting a shared promise rather than re-entering means one disk
    // read, and — more importantly — one `this.clips` array: two reads racing
    // produced two arrays, and whichever mutation landed on the loser was
    // silently dropped.
    if (!this.loading) {
      this.loading = (async () => {
        await this.ensureDir();
        return readIndex();
      })();
    }
    try {
      const clips = await this.loading;
      this.clips ??= clips;
      return this.clips;
    } finally {
      this.loading = null;
    }
  }

  /** Temporary clips, newest first — the "Recent" tab. */
  async listPending(): Promise<Clip[]> {
    return (await this.list()).filter(isPending);
  }

  /** Kept clips, newest first — the "Saved" tab. */
  async listSaved(): Promise<Clip[]> {
    return (await this.list()).filter(c => !isPending(c));
  }

  async add(clip: Clip): Promise<void> {
    await this.mutate(clips => ({ next: [clip, ...clips], result: undefined }));
  }

  async rename(id: string, name: string): Promise<void> {
    await this.mutate(clips => ({
      next: clips.map(c => (c.id === id ? { ...c, name } : c)),
      result: undefined,
    }));
  }

  /** Keep this clip forever: clears the expiry clock. */
  async save(id: string): Promise<void> {
    await this.mutate(clips => ({
      next: clips.map(c =>
        c.id === id ? { ...c, savedAt: c.savedAt ?? Date.now(), expiresAt: null } : c,
      ),
      result: undefined,
    }));
  }

  /** Back to temporary, with a fresh clock. No-op for a clip already pending. */
  async unsave(id: string, retentionHours = FREE_RETENTION_HOURS): Promise<void> {
    const now = Date.now();
    await this.mutate(clips => ({
      next: clips.map(c =>
        c.id === id
          ? { ...c, savedAt: null, expiresAt: now + retentionHours * 3600_000 }
          : c,
      ),
      result: undefined,
    }));
  }

  /**
   * Updates a clip's captioning progress. Kept in the index rather than in
   * memory so a job interrupted by the app being killed is still visible as
   * unfinished on the next launch, and CaptionQueue can pick it back up.
   */
  async setCaptionState(id: string, patch: CaptionPatch): Promise<void> {
    await this.mutate(clips =>
      // The clip may have been deleted or swept while its job was running, in
      // which case there is nothing to patch — but the check has to happen
      // inside the turn, or a delete could land between it and the write and
      // resurrect the clip.
      clips.some(c => c.id === id)
        ? {
            next: clips.map(c => (c.id === id ? { ...c, ...patch } : c)),
            result: undefined,
          }
        : { next: clips, result: undefined },
    );
  }

  /**
   * Records a successful publish. Publishing is an implicit save — a clip the
   * user put on YouTube must not evaporate 24h later.
   */
  async markPublished(id: string, platform: string): Promise<void> {
    await this.mutate(clips => ({
      next: clips.map(c => {
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
      result: undefined,
    }));
  }

  /**
   * Clears the clock on every pending clip. Called when Pro activates, so
   * upgrading rescues whatever was about to expire.
   *
   * The reverse is deliberately not implemented: losing Pro leaves existing
   * clips alone and only newly captured ones get a clock again.
   */
  async rescueExpiring(): Promise<number> {
    const now = Date.now();
    return this.mutate(clips => {
      const pending = clips.filter(isPending);
      return {
        next: clips.map(c =>
          isPending(c) ? { ...c, savedAt: c.savedAt ?? now, expiresAt: null } : c,
        ),
        result: pending.length,
      };
    });
  }

  /**
   * Deletes every clip whose clock has run out, along with its files.
   * Returns what was removed so the UI can tell the user rather than having
   * clips vanish silently.
   */
  async sweepExpired(now = Date.now()): Promise<Clip[]> {
    const expired = await this.mutate(clips => {
      const gone = clips.filter(c => c.expiresAt !== null && c.expiresAt <= now);
      const goneIds = new Set(gone.map(c => c.id));
      return { next: clips.filter(c => !goneIds.has(c.id)), result: gone };
    });
    // Files are deleted after the index no longer references them, and outside
    // the turn: a slow unlink must not hold up the next capture's write.
    for (const clip of expired) {
      await deleteClipFiles(clip);
    }
    return expired;
  }

  async remove(id: string): Promise<void> {
    const clip = await this.mutate(clips => ({
      next: clips.filter(c => c.id !== id),
      result: clips.find(c => c.id === id),
    }));
    if (clip) {
      await deleteClipFiles(clip);
    }
  }

  /** Test seam — drops the in-memory cache so the next list() re-reads disk. */
  resetCache(): void {
    this.clips = null;
    this.loading = null;
  }

  /**
   * Applies one change to the library, start to finish, with nothing else
   * interleaved.
   *
   * `apply` is deliberately synchronous: it runs against the array this turn
   * just read, so there is no point at which it could observe a state some
   * other mutator is halfway through producing. Callers still await their own
   * turn, so an `add()` that resolves has really reached the disk.
   *
   * A failed write does not poison the chain — the next mutation is a fresh
   * read-apply-write, and its state is the newer truth anyway.
   */
  private mutate<T>(apply: (clips: Clip[]) => { next: Clip[]; result: T }): Promise<T> {
    const run = async (): Promise<T> => {
      const { next, result } = apply(await this.list());
      this.clips = next;
      await this.writeIndex();
      return result;
    };
    const chained = this.writeChain.then(run, run);
    this.writeChain = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  private async writeIndex(): Promise<void> {
    const snapshot = JSON.stringify(this.clips ?? []);
    const tmp = `${INDEX_PATH}.tmp`;
    await RNFS.writeFile(tmp, snapshot, 'utf8');
    // Move the live index aside rather than deleting it: between here and the
    // move below there is no index on disk, and that is exactly the window
    // where a kill used to lose the entire library.
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

/** True while the clip is waiting on, or inside, the captioning pipeline. */
export function isCaptioning(clip: Clip): boolean {
  return clip.captionState === 'queued' || clip.captionState === 'processing';
}

/** Milliseconds until wipe, or null if the clip is kept forever. */
export function msUntilExpiry(clip: Clip, now = Date.now()): number | null {
  return clip.expiresAt === null ? null : clip.expiresAt - now;
}

async function readIndex(): Promise<Clip[]> {
  // An index that is absent and an index that is unreadable produce the same
  // empty library but mean opposite things: the first is every first launch,
  // the second is data loss. Only the second is worth an error, so existence is
  // checked rather than inferred from the read throwing.
  let sawExistingFile = false;

  for (const path of [INDEX_PATH, BACKUP_PATH]) {
    if (!(await RNFS.exists(path).catch(() => false))) {
      continue;
    }
    sawExistingFile = true;
    try {
      const raw = await RNFS.readFile(path, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeClip);
      }
      throw new Error('index is not an array');
    } catch (err) {
      // Falling through to the backup silently is how a library could quietly
      // halve itself, so the first failure is recorded even though it recovers.
      log.error(
        `clip index at ${path} exists but could not be read`,
        err,
        ErrorCode.StorageIndexUnreadable,
      );
    }
  }

  if (sawExistingFile) {
    log.error(
      'clip index and backup both exist but neither could be read — library will render empty',
      undefined,
      ErrorCode.StorageIndexUnreadable,
    );
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
  } catch (err) {
    // The path goes in the detail, not the message: the logger dedupes on the
    // message, so interpolating a unique path here would mint a new dedupe key
    // per call and defeat the rate limiter this line most needs.
    log.expected('nothing to delete', err, ErrorCode.StorageDeleteFailed);
  }
}

export const clipStore = new ClipStore();
