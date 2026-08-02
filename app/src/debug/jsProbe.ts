import RNFS from 'react-native-fs';

/**
 * Temporary JS-side probe for the memory termination bug.
 *
 * The native footprint log proved the leak is in the Hermes heap (heap and
 * compressed grow by GBs while `malloc` barely moves), that it is not the
 * preview, the writer, speech, the compositor or capture, and that it starts
 * when the clip player opens. What it cannot see is anything ABOVE the bridge,
 * so five hypotheses about which JS code loops have all been guesses.
 *
 * This writes counters to a file in the app container, which can be pulled with
 * the same `devicectl device copy from` used for the native log — no Metro
 * terminal, no debugger attached, and it survives the OOM kill because it is
 * flushed once a second.
 *
 * Delete this module once the leak is closed.
 */
const PATH = `${RNFS.DocumentDirectoryPath}/js-diagnostics.log`;
const FLUSH_MS = 1000;

const counters: Record<string, number> = {};
let lastConsole = '';
let started = false;

/** Count one occurrence of `key`. Cheap enough for a render body. */
export function bump(key: string): void {
  counters[key] = (counters[key] ?? 0) + 1;
}

export function startJsProbe(): void {
  // Dev only. This appends to a file every second and wraps console.warn/error
  // process-wide, neither of which belongs in a shipping build.
  if (!__DEV__ || started) {
    return;
  }
  started = true;

  // A React "Maximum update depth exceeded" storm — or any repeated warning —
  // shows up here as a console counter climbing by thousands per second. In a
  // dev build LogBox also RETAINS each one with a symbolicated stack, which
  // would explain retained heap growth that the concurrent GC cannot reclaim.
  (['warn', 'error'] as const).forEach(level => {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      bump(`console.${level}`);
      lastConsole = String(args[0]).slice(0, 200);
      original(...args);
    };
  });

  setInterval(() => {
    const line =
      `${new Date().toISOString()} [JS] ` +
      `${JSON.stringify(counters)} last=${JSON.stringify(lastConsole)}\n`;
    RNFS.appendFile(PATH, line, 'utf8').catch(() => {});
  }, FLUSH_MS);
}
