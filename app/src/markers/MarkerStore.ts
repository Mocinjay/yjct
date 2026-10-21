import AsyncStorage from '@react-native-async-storage/async-storage';
import { errorText, importLog } from './importLog';
import type { WakeMarker } from './markerMatching';

const KEY = 'clypso.markers.v1';

/**
 * How long an unclaimed marker survives. The recording a marker belongs to
 * reaches the phone whenever Meta AI next syncs: after a walk home, overnight
 * on a charger, or days later after a trip. A marker is an id and a few
 * timestamps, so a month of them costs nothing, and the sync is not something
 * this app controls.
 */
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Moments the wearer asked for, waiting for the glasses' own recording to
 * appear in the photo library. Persisted because the app is very likely to be
 * killed between the moment and the sync. Writes are serialized, so markers
 * added while an import is removing others are never lost.
 */
export class MarkerStore {
  private markers: WakeMarker[] | null = null;
  private writes: Promise<void> = Promise.resolve();
  private listeners = new Set<(pending: number) => void>();

  constructor(private readonly retentionMs: number = DEFAULT_RETENTION_MS) {}

  private async load(): Promise<WakeMarker[]> {
    if (this.markers !== null) {
      return this.markers;
    }
    let loaded: WakeMarker[];
    try {
      const raw = await AsyncStorage.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      loaded = Array.isArray(parsed)
        ? parsed.filter(
            (m): m is WakeMarker => typeof m?.id === 'string' && typeof m?.atMs === 'number',
          )
        : [];
    } catch (err) {
      // A corrupt store must not stop new markers being recorded.
      importLog('marker store unreadable, starting empty', { error: errorText(err) });
      loaded = [];
    }
    // A concurrent caller may have loaded and changed it meanwhile.
    this.markers ??= loaded;
    return this.markers;
  }

  /**
   * Applies `change` to the current list and saves the result, one write at a
   * time, so concurrent adds and removes compose instead of overwriting.
   */
  private async mutate(change: (markers: WakeMarker[]) => WakeMarker[]): Promise<void> {
    const write = this.writes.then(async () => {
      const cutoff = Date.now() - this.retentionMs;
      const next = change((await this.load()).filter(m => m.atMs >= cutoff));
      this.markers = next;
      await AsyncStorage.setItem(KEY, JSON.stringify(next));
      this.listeners.forEach(listener => listener(next.length));
    });
    this.writes = write.catch(() => {});
    return write;
  }

  async add(marker: WakeMarker): Promise<void> {
    await this.mutate(markers => [...markers, marker]);
    importLog('marker recorded', {
      id: marker.id,
      atMs: marker.atMs,
      startMs: marker.startMs,
      proxyClipId: marker.proxyClipId,
    });
  }

  async all(): Promise<WakeMarker[]> {
    await this.writes;
    const cutoff = Date.now() - this.retentionMs;
    return (await this.load()).filter(m => m.atMs >= cutoff);
  }

  /** Forgets markers that have been turned into clips. */
  async remove(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const drop = new Set(ids);
    await this.mutate(markers => markers.filter(m => !drop.has(m.id)));
  }

  /** Calls `listener` with the pending count after every change. */
  subscribe(listener: (pending: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const markerStore = new MarkerStore();
