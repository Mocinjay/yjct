import { logger, type LogEntry, type LogSink } from '../src/core/Logger';
import { AppError, ErrorCode } from '../src/core/errors';

/** Collects everything the logger emits so assertions read against real output. */
function captureSink(): { entries: LogEntry[]; sink: LogSink } {
  const entries: LogEntry[] = [];
  return { entries, sink: { write: e => entries.push(e) } };
}

let removeSink: (() => void) | null = null;
let now = 1_000_000;

beforeEach(() => {
  now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  logger.clear();
  // The logger silences itself under Jest so suites stay readable; these tests
  // are about the logger, so they opt back in.
  logger.setMinLevel('debug');
});

afterEach(() => {
  removeSink?.();
  removeSink = null;
  logger.setMinLevel('silent');
  logger.clear();
  jest.restoreAllMocks();
});

describe('level filtering', () => {
  it('drops entries below the configured level', () => {
    const { entries, sink } = captureSink();
    removeSink = logger.addSink(sink);
    logger.setMinLevel('warn');

    const log = logger.scope('test');
    log.debug('nope');
    log.info('also nope');
    log.warn('yes');
    log.error('definitely');

    expect(entries.map(e => e.level)).toEqual(['warn', 'error']);
  });

  it('silent drops everything', () => {
    const { entries, sink } = captureSink();
    removeSink = logger.addSink(sink);
    logger.setMinLevel('silent');

    logger.scope('test').error('not recorded');

    expect(entries).toHaveLength(0);
  });
});

describe('rate limiting', () => {
  it('collapses identical messages inside the dedupe window', () => {
    const { entries, sink } = captureSink();
    removeSink = logger.addSink(sink);
    const log = logger.scope('glasses');

    for (let i = 0; i < 10; i++) {
      now += 100;
      log.warn('link dropped');
    }

    expect(entries).toHaveLength(1);
  });

  it('reports how many repeats it swallowed once the window passes', () => {
    const { entries, sink } = captureSink();
    removeSink = logger.addSink(sink);
    const log = logger.scope('glasses');

    log.warn('link dropped');
    for (let i = 0; i < 4; i++) {
      now += 100;
      log.warn('link dropped');
    }
    now += 6000;
    log.warn('link dropped');

    expect(entries).toHaveLength(2);
    expect(entries[0].suppressed).toBe(0);
    expect(entries[1].suppressed).toBe(4);
  });

  it('does not collapse different messages from the same scope', () => {
    const { entries, sink } = captureSink();
    removeSink = logger.addSink(sink);
    const log = logger.scope('glasses');

    log.warn('link dropped');
    log.warn('stream stalled');

    expect(entries).toHaveLength(2);
  });

  it('does not collapse the same message from different scopes', () => {
    const { entries, sink } = captureSink();
    removeSink = logger.addSink(sink);

    logger.scope('capture').warn('stopped');
    logger.scope('wakeword').warn('stopped');

    expect(entries).toHaveLength(2);
  });
});

describe('retention', () => {
  it('keeps a bounded tail rather than growing without limit', () => {
    logger.setMinLevel('debug');
    const log = logger.scope('spam');
    for (let i = 0; i < 500; i++) {
      now += 10_000; // outrun the dedupe window so every line is distinct
      log.info(`entry ${i}`);
    }

    const recent = logger.recent();
    expect(recent).toHaveLength(200);
    // Oldest-first, and it is the *tail* that survives.
    expect(recent[recent.length - 1].message).toBe('entry 499');
  });
});

describe('sinks', () => {
  it('a sink that throws cannot take down the caller', () => {
    const exploding: LogSink = {
      write: () => {
        throw new Error('sink is broken');
      },
    };
    const { entries, sink } = captureSink();
    const removeExploding = logger.addSink(exploding);
    removeSink = logger.addSink(sink);

    expect(() => logger.scope('test').error('still logged')).not.toThrow();
    expect(entries).toHaveLength(1);

    removeExploding();
  });

  it('removing a sink stops delivery to it', () => {
    const { entries, sink } = captureSink();
    const remove = logger.addSink(sink);

    logger.scope('test').warn('one');
    remove();
    now += 10_000;
    logger.scope('test').warn('two');

    expect(entries).toHaveLength(1);
  });
});

describe('error()', () => {
  it('returns a typed AppError carrying the code it was given', () => {
    const returned = logger
      .scope('capture')
      .error('could not arm', new Error('camera busy'), ErrorCode.CaptureArmFailed);

    expect(returned).toBeInstanceOf(AppError);
    expect(returned.code).toBe(ErrorCode.CaptureArmFailed);
    expect(returned.domain).toBe('capture');
  });

  it('preserves an AppError thrown deeper in the stack instead of relabelling it', () => {
    const original = new AppError(
      ErrorCode.WakeWordPermissionDenied,
      'denied at the OS level',
    );

    const returned = logger
      .scope('capture')
      .error('could not arm', original, ErrorCode.CaptureArmFailed);

    // The specific cause outranks the general boundary code.
    expect(returned).toBe(original);
    expect(returned.code).toBe(ErrorCode.WakeWordPermissionDenied);
  });

  it('records the underlying detail alongside the code', () => {
    const { entries, sink } = captureSink();
    removeSink = logger.addSink(sink);

    logger
      .scope('capture')
      .error('could not arm', new Error('camera busy'), ErrorCode.CaptureArmFailed);

    expect(entries[0].code).toBe(ErrorCode.CaptureArmFailed);
    expect(entries[0].context).toMatchObject({ detail: 'camera busy' });
  });

  it('falls back to an unexpected code when none is supplied', () => {
    const returned = logger.scope('test').error('something odd', new Error('boom'));
    expect(returned.code).toBe(ErrorCode.Unexpected);
  });
});

describe('expected()', () => {
  it('logs at debug so routine recoveries do not read as failures', () => {
    const { entries, sink } = captureSink();
    removeSink = logger.addSink(sink);

    logger
      .scope('capture')
      .expected('file already gone', new Error('ENOENT'), ErrorCode.StorageDeleteFailed);

    expect(entries[0].level).toBe('debug');
    expect(entries[0].code).toBe(ErrorCode.StorageDeleteFailed);
  });
});

describe('dedupe key retention', () => {
  it('does not grow without bound when every message is distinct', () => {
    // The dedupe key includes the message, and the wake word logged one line
    // per 5s segment with the transcript interpolated into it. Nothing removed
    // a key, so an armed session grew this map for as long as it ran.
    //
    // Date.now is frozen by the suite setup, so nothing here can expire — this
    // exercises the size cap, which is the backstop for the case expiry cannot
    // help with.
    const { sink } = captureSink();
    removeSink = logger.addSink(sink);

    for (let i = 0; i < 5000; i++) {
      logger.scope('wakeword').warn(`transcript ${i}`);
    }

    expect(dedupeSize()).toBeLessThanOrEqual(512);
  });

  it('still suppresses a repeat inside the window after pruning', () => {
    const { entries, sink } = captureSink();
    removeSink = logger.addSink(sink);

    // Push the map well past its cap with keys that will never repeat...
    for (let i = 0; i < 5000; i++) {
      logger.scope('wakeword').warn(`transcript ${i}`);
    }
    entries.length = 0;

    // ...then check the thing the map exists for still works. Eviction drops
    // the coldest keys, so one just written has to survive.
    logger.scope('hardware').warn('link dropped');
    logger.scope('hardware').warn('link dropped');

    expect(entries).toHaveLength(1);
  });
});

/** Reaches the private map — its size is the whole point of these two tests. */
function dedupeSize(): number {
  return (logger as unknown as { dedupe: Map<string, unknown> }).dedupe.size;
}
