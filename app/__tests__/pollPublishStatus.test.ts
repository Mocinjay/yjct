import type { PublishStatus } from '../src/phase2/PublishTarget';
import { pollPublishStatus } from '../src/ui/pollPublishStatus';

/** Lets pending promise callbacks run without advancing fake time. */
const flush = () => new Promise<void>(resolve => jest.requireActual('timers').setImmediate(resolve));

describe('pollPublishStatus', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('checks once and stops when the first status is already final', async () => {
    const check = jest.fn(async (): Promise<PublishStatus> => ({ state: 'published' }));
    const seen: PublishStatus[] = [];

    await pollPublishStatus(check, s => seen.push(s), () => true, 2000);
    jest.advanceTimersByTime(10_000);

    expect(check).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ state: 'published' }]);
  });

  it('keeps polling through pending and processing, then stops on failed', async () => {
    const states: PublishStatus['state'][] = ['pending', 'processing', 'failed'];
    const check = jest.fn(async (): Promise<PublishStatus> => ({ state: states.shift()! }));
    const seen: string[] = [];

    const done = pollPublishStatus(check, s => seen.push(s.state), () => true, 2000);
    await flush();
    expect(seen).toEqual(['pending']);
    jest.advanceTimersByTime(2000);
    await flush();
    jest.advanceTimersByTime(2000);
    await done;

    expect(seen).toEqual(['pending', 'processing', 'failed']);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('never starts a check while the previous one is still running', async () => {
    let resolveSlow: (s: PublishStatus) => void = () => {};
    const check = jest
      .fn<Promise<PublishStatus>, []>()
      .mockImplementationOnce(() => new Promise(resolve => (resolveSlow = resolve)))
      .mockResolvedValue({ state: 'published' });

    const done = pollPublishStatus(check, () => {}, () => true, 2000);
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(check).toHaveBeenCalledTimes(1);

    resolveSlow({ state: 'processing' });
    await flush();
    jest.advanceTimersByTime(2000);
    await done;
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('reports a check that throws as failed and stops', async () => {
    const check = jest.fn(async (): Promise<PublishStatus> => {
      throw new Error('Network request failed');
    });
    const seen: PublishStatus[] = [];

    await pollPublishStatus(check, s => seen.push(s), () => true, 2000);

    expect(seen).toEqual([{ state: 'failed', error: 'Network request failed' }]);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('stops fetching and reporting once the screen is gone', async () => {
    let active = true;
    const check = jest.fn(async (): Promise<PublishStatus> => ({ state: 'processing' }));
    const seen: PublishStatus[] = [];

    const done = pollPublishStatus(check, s => seen.push(s), () => active, 2000);
    await flush();
    active = false;
    jest.advanceTimersByTime(2000);
    await done;
    jest.advanceTimersByTime(10_000);

    expect(check).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });

  it('does nothing when the screen left before the upload finished', async () => {
    const check = jest.fn(async (): Promise<PublishStatus> => ({ state: 'processing' }));
    const onStatus = jest.fn();

    await pollPublishStatus(check, onStatus, () => false, 2000);

    expect(check).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('drops a status that lands after the screen is gone', async () => {
    let active = true;
    const onStatus = jest.fn();
    const check = jest.fn(async (): Promise<PublishStatus> => {
      active = false;
      return { state: 'processing' };
    });

    await pollPublishStatus(check, onStatus, () => active, 2000);

    expect(onStatus).not.toHaveBeenCalled();
  });
});
