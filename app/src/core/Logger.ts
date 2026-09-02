import { AppError, describe, ErrorCode } from './errors';

/**
 * One logger for the whole app.
 *
 * Before this there were three conventions — bare `console.log` with a
 * hand-written `[tag]` prefix, `.catch(() => {})` that said nothing at all, and
 * a native-side file log the JS layer could not reach. Failures on the two paths
 * that matter most (the glasses link dropping, the recognizer refusing segments)
 * were the ones most likely to be invisible, because both are retried on a timer
 * and a retry loop is exactly what an empty catch hides.
 *
 * Three things this has to do that `console` does not:
 *
 * 1. **Rate-limit.** A dropped glasses link re-arms every 4s and a recognizer
 *    failure recurs once per 5s segment. Unthrottled that is a screenful of
 *    identical lines per minute, which buries everything else.
 * 2. **Retain.** The last N entries are kept in memory so a diagnostics view —
 *    or a bug report — can show what led up to a failure. Console output is
 *    gone the moment the app is killed, which is precisely when it is wanted.
 * 3. **Fan out.** Sinks are pluggable, so the native `DiagnosticLog` file can be
 *    fed from JS later without touching a single call site.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LogEntry {
  at: number;
  level: Exclude<LogLevel, 'silent'>;
  scope: string;
  message: string;
  code?: ErrorCode;
  context?: Record<string, unknown>;
  /** Repeats folded into this entry by the rate limiter. 0 when it is the first. */
  suppressed: number;
}

export interface LogSink {
  write(entry: LogEntry): void;
}

/** Identical messages inside this window collapse into one line. */
const DEDUPE_WINDOW_MS = 5000;

/** How many entries stay in memory for diagnostics. */
const RETAINED_ENTRIES = 200;

/**
 * Ceiling on distinct dedupe keys held at once.
 *
 * The key includes the message, and messages interpolate volatile detail at
 * enough call sites that the set is effectively unbounded — a session armed for
 * an hour mints one key per 5s segment transcript and never drops any of them.
 * Anything older than the dedupe window can no longer suppress a thing, so
 * evicting the coldest keys costs nothing but a possible extra duplicate line.
 */
const MAX_DEDUPE_KEYS = 512;

const isDev = typeof __DEV__ !== 'undefined' && __DEV__;

/**
 * Declared locally rather than depending on @types/node: Metro shims
 * `process.env` at runtime, and pulling a Node type dependency into the app to
 * type one test-detection check is not a trade worth making.
 */
declare const process: { env?: Record<string, string | undefined> } | undefined;

/**
 * Jest sets JEST_WORKER_ID on every worker. Detecting it here rather than
 * expecting each test file to silence the logger keeps test output readable
 * without a shared setup file that could drift from the suite.
 */
const isTest =
  typeof process !== 'undefined' && process?.env?.JEST_WORKER_ID !== undefined;

const CONSOLE_METHOD: Record<Exclude<LogLevel, 'silent'>, 'log' | 'warn' | 'error'> =
  {
    debug: 'log',
    info: 'log',
    warn: 'warn',
    error: 'error',
  };

/**
 * One entry as a single line, minus its context.
 *
 * Shared with the native diagnostics sink, which had grown its own copy —
 * including the `(+N repeated)` suffix, which is the part a reader has to be
 * able to trust: a line without it means the failure really did happen once.
 *
 * `scopePrefix` is the sink's own tag for where the line came from; the file
 * carries native lines too, so JS ones say so.
 */
export function formatEntry(entry: LogEntry, scopePrefix = ''): string {
  const parts = [`[${scopePrefix}${entry.scope}]`, entry.message];
  if (entry.code) {
    parts.push(`(${entry.code})`);
  }
  if (entry.suppressed > 0) {
    parts.push(`(+${entry.suppressed} repeated)`);
  }
  return parts.join(' ');
}

export const consoleSink: LogSink = {
  write(entry) {
    const line = formatEntry(entry);
    if (entry.context) {
      console[CONSOLE_METHOD[entry.level]](line, entry.context);
    } else {
      console[CONSOLE_METHOD[entry.level]](line);
    }
  },
};

interface DedupeState {
  lastEmittedAt: number;
  suppressed: number;
}

class Logger {
  private minLevel: LogLevel = isTest ? 'silent' : isDev ? 'debug' : 'info';
  private sinks: LogSink[] = [consoleSink];
  private entries: LogEntry[] = [];
  private dedupe = new Map<string, DedupeState>();

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  addSink(sink: LogSink): () => void {
    this.sinks.push(sink);
    return () => {
      this.sinks = this.sinks.filter(s => s !== sink);
    };
  }

  /** The retained tail, oldest first. */
  recent(limit = RETAINED_ENTRIES): LogEntry[] {
    return this.entries.slice(-limit);
  }

  clear(): void {
    this.entries = [];
    this.dedupe.clear();
  }

  scope(name: string): ScopedLogger {
    return new ScopedLogger(this, name);
  }

  write(
    level: Exclude<LogLevel, 'silent'>,
    scope: string,
    message: string,
    code?: ErrorCode,
    context?: Record<string, unknown>,
  ): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) {
      return;
    }

    // Keyed on the message, not the context: the context is where the volatile
    // detail lives (paths, counters), so including it would defeat the dedupe
    // for exactly the repeating failures this exists to collapse.
    const key = `${level}|${scope}|${message}`;
    const now = Date.now();
    const seen = this.dedupe.get(key);
    if (seen && now - seen.lastEmittedAt < DEDUPE_WINDOW_MS) {
      seen.suppressed += 1;
      return;
    }

    const entry: LogEntry = {
      at: now,
      level,
      scope,
      message,
      code,
      context,
      suppressed: seen?.suppressed ?? 0,
    };
    // Re-inserting rather than mutating keeps Map iteration order equal to
    // recency, which is what makes the eviction below drop the coldest keys.
    this.dedupe.delete(key);
    this.dedupe.set(key, { lastEmittedAt: now, suppressed: 0 });
    this.pruneDedupe(now);

    this.entries.push(entry);
    if (this.entries.length > RETAINED_ENTRIES) {
      this.entries.splice(0, this.entries.length - RETAINED_ENTRIES);
    }

    for (const sink of this.sinks) {
      try {
        sink.write(entry);
      } catch {
        // A logger that can throw is a logger that takes the app down with it.
      }
    }
  }

  /**
   * Drops keys that can no longer suppress anything.
   *
   * Expiry first, because it is exact: a key older than the window is dead
   * whatever the map size. The size cap is the backstop for the case expiry
   * cannot help with — many distinct keys all minted inside one window.
   */
  private pruneDedupe(now: number): void {
    if (this.dedupe.size <= MAX_DEDUPE_KEYS) {
      return;
    }
    for (const [key, state] of this.dedupe) {
      if (now - state.lastEmittedAt >= DEDUPE_WINDOW_MS) {
        this.dedupe.delete(key);
      }
    }
    // Insertion order is recency, so the head of the map is the coldest.
    for (const key of this.dedupe.keys()) {
      if (this.dedupe.size <= MAX_DEDUPE_KEYS) {
        break;
      }
      this.dedupe.delete(key);
    }
  }
}

export class ScopedLogger {
  constructor(private logger: Logger, private name: string) {}

  debug(message: string, context?: Record<string, unknown>): void {
    this.logger.write('debug', this.name, message, undefined, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.logger.write('info', this.name, message, undefined, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.logger.write('warn', this.name, message, undefined, context);
  }

  /**
   * Logs a failure. Pass the caught value directly — an `AppError` contributes
   * its code and context, anything else is described as best it can be.
   *
   * Returns the `AppError` it logged, so a call site can log and rethrow (or
   * store the result) without restating the wrapping:
   *
   *     throw log.error('arming failed', err, ErrorCode.CaptureArmFailed);
   */
  error(message: string, cause?: unknown, code?: ErrorCode): AppError {
    const wrapped =
      cause === undefined
        ? new AppError(code ?? ErrorCode.Unexpected, message)
        : AppError.from(cause, code ?? ErrorCode.Unexpected);

    this.logger.write('error', this.name, message, wrapped.code, {
      ...wrapped.context,
      ...(cause === undefined ? {} : { detail: describe(cause) }),
    });
    return wrapped;
  }

  /**
   * For failures that are expected and recoverable — a temp file that was
   * already evicted, a teardown on something already torn down. These used to
   * be `.catch(() => {})`; they are not worth an error, but "never happens" and
   * "happens constantly" must be distinguishable.
   */
  expected(message: string, cause: unknown, code: ErrorCode): void {
    this.logger.write('debug', this.name, message, code, {
      detail: describe(cause),
    });
  }
}

export const logger = new Logger();

/** Convenience for module-scope loggers: `const log = createLogger('capture');` */
export function createLogger(scope: string): ScopedLogger {
  return logger.scope(scope);
}
