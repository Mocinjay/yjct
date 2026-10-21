/**
 * Display formatting shared by the Library, Player and Armed screens. Pure
 * functions, kept out of the screen modules so screens do not import each
 * other and these can be unit-tested on their own.
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

/** Seconds as m:ss, e.g. 75.4 → "1:15". */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Built once: toLocale*String builds a new formatter on every call (an
// NSDateFormatter under Hermes on iOS), and relativeDate runs per Library card.
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

/** "Today 3:42 PM", "Yesterday", or "Mar 4", in the device locale. */
export function relativeDate(epochMs: number, now = new Date()): string {
  const d = new Date(epochMs);
  if (d.toDateString() === now.toDateString()) {
    return `Today ${TIME_FORMAT.format(d)}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return DAY_FORMAT.format(d);
}
