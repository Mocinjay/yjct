import RNFS from 'react-native-fs';
import { FREE_RETENTION_HOURS } from '../config';
import type { Clip } from '../types';

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
    await this.ensureDir();
    this.clips = await readIndex();
    return this.clips;
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
    const clips = await this.list();
    this.clips = [clip, ...clips];
    await this.persist();
  }

  async rename(id: string, name: string): Promise<void> {
    const clips = await this.list();
    this.clips = clips.map(c => (c.id === id ? { ...c, name } : c));
    await this.persist();
  }

  /** Keep this clip forever: clears the expiry clock. */
  async save(id: string): Promise<void> {
    const clips = await this.list();
    this.clips = clips.map(c =>
      c.id === id ? { ...c, savedAt: c.savedAt ?? Date.now(), expiresAt: null } : c,
    );
    await this.persist();
  }

  /** Back to temporary, with a fresh clock. No-op for a clip already pending. */
  async unsave(id: string, retentionHours = FREE_RETENTION_HOURS): Promise<void> {
    const clips = await this.list();
    const now = Date.now();
    this.clips = clips.map(c =>
      c.id === id
        ? { ...c, savedAt: null, expiresAt: now + retentionHours * 3600_000 }
        : c,
    );
    await this.persist();
  }

  /**
   * Updates a clip's captioning progress. Kept in the index rather than in
   * memory so a job interrupted by the app being killed is still visible as
   * unfinished on the next launch, and CaptionQueue can pick it back up.
   */
  async setCaptionState(id: string, patch: CaptionPatch): Promise<void> {
    const clips = await this.list();
    if (!clips.some(c => c.id === id)) {
      // The clip was deleted or swept while its job was running.
      return;
    }
    this.clips = clips.map(c => (c.id === id ? { ...c, ...patch } : c));
    await this.persist();
  }

  /**
   * Records a successful publish. Publishing is an implicit save — a clip the
   * user put on YouTube must not evaporate 24h later.
   */
  async markPublished(id: string, platform: string): Promise<void> {
    const clips = await this.list();
    this.clips = clips.map(c => {
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
    });
    await this.persist();
  }

  /**
   * Clears the clock on every pending clip. Called when Pro activates, so
   * upgrading rescues whatever was about to expire.
   *
   * The reverse is deliberately not implemented: losing Pro leaves existing
   * clips alone and only newly captured ones get a clock again.
   */
  async rescueExpiring(): Promise<number> {
    const clips = await this.list();
    const pending = clips.filter(isPending);
    if (pending.length === 0) {
      return 0;
    }
    const now = Date.now();
    this.clips = clips.map(c =>
      isPending(c) ? { ...c, savedAt: c.savedAt ?? now, expiresAt: null } : c,
    );
    await this.persist();
    return pending.length;
  }

  /**
   * Deletes every clip whose clock has run out, along with its files.
   * Returns what was removed so the UI can tell the user rather than having
   * clips vanish silently.
   */
  async sweepExpired(now = Date.now()): Promise<Clip[]> {
    const clips = await this.list();
    const expired = clips.filter(c => c.expiresAt !== null && c.expiresAt <= now);
    if (expired.length === 0) {
      return [];
    }
    const expiredIds = new Set(expired.map(c => c.id));
    this.clips = clips.filter(c => !expiredIds.has(c.id));
    await this.persist();
    for (const clip of expired) {
      await deleteClipFiles(clip);
    }
    return expired;
  }

  async remove(id: string): Promise<void> {
    const clips = await this.list();
    const clip = clips.find(c => c.id === id);
    this.clips = clips.filter(c => c.id !== id);
    await this.persist();
    if (clip) {
      await deleteClipFiles(clip);
    }
  }

  /** Test seam — drops the in-memory cache so the next list() re-reads disk. */
  resetCache(): void {
    this.clips = null;
  }

  private async persist(): Promise<void> {
    const tmp = `${INDEX_PATH}.tmp`;
    await RNFS.writeFile(tmp, JSON.stringify(this.clips ?? []), 'utf8');
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
