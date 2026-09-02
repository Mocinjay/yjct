/**
 * How clip numbers and dates are written on screen.
 *
 * These lived on LibraryScreen, which meant the player and the armed screen
 * each imported a sibling *screen* to get at a duration formatter — a
 * dependency between two things that have nothing to do with each other, and
 * one that pulled a FlatList, a share sheet and a store hook into the module
 * graph of anything that wanted `m:ss`.
 */

/** "23h left" / "42m left" / "expiring" once the clock has run out. */
export function formatRemaining(ms: number): string {
  if (ms <= 0) {
    return 'expiring';
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) {
    return `${Math.max(1, minutes)}m left`;
  }
  return `${Math.floor(minutes / 60)}h left`;
}

/** "1:07" — minutes and seconds, for a clip length or a running timer. */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "Today 4:31 PM" / "Yesterday" / "Sep 2". */
export function relativeDate(epochMs: number): string {
  const d = new Date(epochMs);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `Today ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
