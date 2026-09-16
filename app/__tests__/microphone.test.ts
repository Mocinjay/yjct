import { microphone } from '../src/core/microphone';

/**
 * One microphone, one owner.
 *
 * These are handover tests, not audio tests. Nothing here opens a microphone;
 * what is being pinned down is the sequencing, because the bug this arbiter
 * exists to prevent is a race rather than a wrong answer — the live-capture
 * path used to reach the audio session while the glasses-library path was still
 * inside its own teardown, and both halves are written to survive losing the
 * input, so the collision left no error behind. It presented as a trigger word
 * that worked sometimes.
 */

interface Yielder {
  standDown: jest.Mock<Promise<void>, []>;
  standUp: jest.Mock<Promise<void>, []>;
  events: string[];
}

/** A stand-down/stand-up pair that records the order it was called in. */
function yielder(options: { standDownFails?: boolean } = {}): Yielder {
  const events: string[] = [];
  return {
    events,
    standDown: jest.fn(async () => {
      events.push('down');
      if (options.standDownFails) {
        throw new Error('the recorder would not close');
      }
    }),
    standUp: jest.fn(async () => {
      events.push('up');
    }),
  };
}

beforeEach(() => {
  microphone.reset();
});

describe('acquiring for live capture', () => {
  it('waits for the other half to close before it resolves', async () => {
    const other = yielder();
    let closed = false;
    other.standDown.mockImplementation(async () => {
      // A teardown that takes a turn of the loop, which is what a real one
      // does: it crosses the bridge and stops an AVAudioEngine.
      await Promise.resolve();
      closed = true;
    });
    await microphone.register(other);

    await microphone.acquireExclusive();

    // The whole point. If this ever reads false, the capture path is
    // configuring an audio session that something else is still tapping.
    expect(closed).toBe(true);
    expect(microphone.heldBy).toBe('live-capture');
    expect(microphone.standingDown).toBe(true);
  });

  it('stands the other half down exactly once across repeated claims', async () => {
    const other = yielder();
    await microphone.register(other);

    await microphone.acquireExclusive();
    await microphone.acquireExclusive();

    expect(other.standDown).toHaveBeenCalledTimes(1);
  });

  it('claims anyway when nothing is registered to yield', async () => {
    await microphone.acquireExclusive();

    expect(microphone.heldBy).toBe('live-capture');
    expect(microphone.standingDown).toBe(false);
  });

  it('still takes the microphone when the other half refuses to let go', async () => {
    const other = yielder({ standDownFails: true });
    await microphone.register(other);

    await expect(microphone.acquireExclusive()).resolves.toBeUndefined();

    // Refusing to arm over this would turn a recoverable audio problem into
    // what looks to the wearer like broken glasses.
    expect(microphone.heldBy).toBe('live-capture');
  });
});

describe('releasing', () => {
  it('brings the other half back up', async () => {
    const other = yielder();
    await microphone.register(other);

    await microphone.acquireExclusive();
    await microphone.releaseExclusive();

    expect(other.events).toEqual(['down', 'up']);
    expect(microphone.heldBy).toBeNull();
    expect(microphone.standingDown).toBe(false);
  });

  it('is idempotent, because arm() disarms on its own failure path', async () => {
    const other = yielder();
    await microphone.register(other);

    await microphone.acquireExclusive();
    await microphone.releaseExclusive();
    await microphone.releaseExclusive();

    expect(other.standUp).toHaveBeenCalledTimes(1);
  });

  it('resumes a half that registered after the claim was already made', async () => {
    const other = yielder();
    await microphone.acquireExclusive();
    // Registration stands it down on the spot (see below), so it is owed a
    // resume even though it was not there when the claim happened.
    await microphone.register(other);

    await microphone.releaseExclusive();

    expect(other.events).toEqual(['down', 'up']);
  });
});

describe('registration', () => {
  it('stands down on the spot when capture already holds the microphone', async () => {
    await microphone.acquireExclusive();

    const other = yielder();
    await microphone.register(other);

    // The wearer foregrounding the app mid-session is exactly this: the import
    // service starts, and the capture path armed minutes ago.
    expect(other.standDown).toHaveBeenCalledTimes(1);
    expect(microphone.standingDown).toBe(true);
  });

  it('does not stand down when nothing holds the microphone', async () => {
    const other = yielder();
    await microphone.register(other);

    expect(other.standDown).not.toHaveBeenCalled();
    expect(microphone.standingDown).toBe(false);
  });

  it('stops calling a half that has unregistered', async () => {
    const other = yielder();
    await microphone.register(other);
    microphone.unregister();

    await microphone.acquireExclusive();
    await microphone.releaseExclusive();

    expect(other.standDown).not.toHaveBeenCalled();
    expect(other.standUp).not.toHaveBeenCalled();
  });
});

describe('subscribers', () => {
  it('reports the holder so a screen can stop claiming to be listening', async () => {
    const seen: (string | null)[] = [];
    const unsubscribe = microphone.subscribe(holder => seen.push(holder));

    await microphone.acquireExclusive();
    await microphone.releaseExclusive();
    unsubscribe();
    await microphone.acquireExclusive();

    expect(seen).toEqual(['live-capture', null]);
  });
});
