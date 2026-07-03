import RNFS from 'react-native-fs';
import type { Clip } from '../types';

const CLIPS_DIR = `${RNFS.DocumentDirectoryPath}/clips`;
const INDEX_PATH = `${CLIPS_DIR}/index.json`;

/**
 * Local clip library: MP4s + thumbnails under Documents/clips, with a JSON
 * index. All mutations rewrite the index atomically (write temp, move).
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
    try {
      const raw = await RNFS.readFile(INDEX_PATH, 'utf8');
      this.clips = JSON.parse(raw) as Clip[];
    } catch {
      this.clips = [];
    }
    return this.clips;
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

  async remove(id: string): Promise<void> {
    const clips = await this.list();
    const clip = clips.find(c => c.id === id);
    this.clips = clips.filter(c => c.id !== id);
    await this.persist();
    if (clip) {
      await deleteIfExists(clip.filePath);
      await deleteIfExists(clip.thumbnailPath);
    }
  }

  private async persist(): Promise<void> {
    const tmp = `${INDEX_PATH}.tmp`;
    await RNFS.writeFile(tmp, JSON.stringify(this.clips ?? []), 'utf8');
    await deleteIfExists(INDEX_PATH);
    await RNFS.moveFile(tmp, INDEX_PATH);
    this.listeners.forEach(l => l());
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
