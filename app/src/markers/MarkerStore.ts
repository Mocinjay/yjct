import AsyncStorage from '@react-native-async-storage/async-storage';
import { createLogger } from '../core/Logger';
import { ErrorCode } from '../core/errors';
import type { WakeMarker } from './markerMatching';

const log = createLogger('markers');

const KEY = 'clypso.markers.v1';

/**
 * How long an unclaimed marker survives.
 *
 * Markers routinely outlive the moment by a long way: the wearer says the word,
 * and the recording it belongs to does not reach the phone until Meta AI next
 * syncs — which may be after a walk home, overnight on a charger, or not until
 * the glasses are next opened after a trip. A marker discarded before its
 * footage arrives is a moment lost with no trace.
 *
 * Deliberately far longer than the free tier's 24-hour clip expiry, and not
 * derived from it. That number is about storage — clips are megabytes. A marker
 * is an id and a timestamp, so keeping a month of them costs nothing, and the
 * sync it is waiting on is not something this app controls.
 */
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Trigger words the phone heard, waiting for footage to appear.
 *
 * Persisted rather than held in memory because the two halves of this feature
 * are separated by however long a sync takes, and the app is very likely to be
 * killed in between — it spends that whole window backgrounded.
 */
export class MarkerStore {
  private markers: WakeMarker[] | null = null;

  constructor(private readonly retentionMs: number = DEFAULT_RETENTION_MS) {}

  private async load(): Promise<WakeMarker[]> {
    if (this.markers !== null) {
      return this.markers;
    }
    try {
      const raw = await AsyncStorage.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      this.markers = Array.isArray(parsed)
        ? parsed.filter(
            (m): m is WakeMarker =>
              typeof m?.id === 'string' && typeof m?.atMs === 'number',
          )
        : [];
    } catch (err) {
      // A corrupt store must not take the trigger word down with it — losing
      // pending markers is bad, refusing to record new ones is worse.
      log.expected(
        'marker store unreadable — starting empty',
        err,
        ErrorCode.StorageIndexUnreadable,
      );
      this.markers = [];
    }
    return this.markers;
  }

  private async persist(next: WakeMarker[]): Promise<void> {
    this.markers = next;
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  }

  async add(marker: WakeMarker): Promise<void> {
    const markers = await this.load();
    const cutoff = Date.now() - this.retentionMs;
    const next = [...markers.filter(m => m.atMs >= cutoff), marker];
    await this.persist(next);
    log.info('marker recorded', { atMs: marker.atMs, pending: next.length });
  }

  async all(): Promise<WakeMarker[]> {
    const markers = await this.load();
    const cutoff = Date.now() - this.retentionMs;
    return markers.filter(m => m.atMs >= cutoff);
  }

  /** Forget markers that have been turned into clips. */
  async remove(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const drop = new Set(ids);
    const markers = await this.load();
    await this.persist(markers.filter(m => !drop.has(m.id)));
  }

  async clear(): Promise<void> {
    await this.persist([]);
  }
}
