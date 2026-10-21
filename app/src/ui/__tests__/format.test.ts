import { formatDuration, formatRemaining, relativeDate } from '../format';

describe('formatRemaining', () => {
  it('counts hours, then minutes, then says expiring', () => {
    expect(formatRemaining(23 * 3600_000 + 59 * 60_000)).toBe('23h left');
    expect(formatRemaining(60 * 60_000)).toBe('1h left');
    expect(formatRemaining(42 * 60_000 + 30_000)).toBe('42m left');
    // Under a minute still reads as time left, not "0m".
    expect(formatRemaining(10_000)).toBe('1m left');
    expect(formatRemaining(0)).toBe('expiring');
    expect(formatRemaining(-5_000)).toBe('expiring');
  });
});

describe('formatDuration', () => {
  it('formats m:ss, rounding and clamping', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9.4)).toBe('0:09');
    expect(formatDuration(75.6)).toBe('1:16');
    expect(formatDuration(600)).toBe('10:00');
    expect(formatDuration(-3)).toBe('0:00');
  });
});

describe('relativeDate', () => {
  const now = new Date(2026, 9, 20, 15, 30);

  it('shows the time for today', () => {
    const today = new Date(2026, 9, 20, 9, 5);
    const time = today.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    expect(relativeDate(today.getTime(), now)).toBe(`Today ${time}`);
  });

  it('says Yesterday for the previous calendar day, however late', () => {
    expect(relativeDate(new Date(2026, 9, 19, 23, 59).getTime(), now)).toBe('Yesterday');
    expect(relativeDate(new Date(2026, 9, 19, 0, 1).getTime(), now)).toBe('Yesterday');
  });

  it('shows month and day for anything older', () => {
    const older = new Date(2026, 2, 4, 12, 0);
    const day = older.toLocaleDateString([], { month: 'short', day: 'numeric' });
    expect(relativeDate(older.getTime(), now)).toBe(day);
  });

  it('handles yesterday across a month boundary', () => {
    const firstOfMonth = new Date(2026, 10, 1, 8, 0);
    expect(relativeDate(new Date(2026, 9, 31, 22, 0).getTime(), firstOfMonth)).toBe(
      'Yesterday',
    );
  });
});
