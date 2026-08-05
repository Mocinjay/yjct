import {
  AppError,
  ErrorCode,
  describe as describeError,
  isAppError,
  userMessageFor,
} from '../src/core/errors';

describe('AppError', () => {
  it('survives instanceof across the Babel/Hermes ES5 target', () => {
    // Subclassing Error is the classic case where a downlevelled build breaks
    // the prototype chain and every AppError silently reads as a plain Error.
    const err = new AppError(ErrorCode.CaptureArmFailed, 'boom');
    expect(err instanceof AppError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(isAppError(err)).toBe(true);
  });

  it('derives its domain from the code', () => {
    expect(new AppError(ErrorCode.GlassesSessionFailed, 'x').domain).toBe('hardware');
    expect(new AppError(ErrorCode.WakeWordStartFailed, 'x').domain).toBe('wakeword');
    expect(new AppError(ErrorCode.CaptionJobFailed, 'x').domain).toBe('captioning');
  });

  it('keeps the developer message separate from the wearer-facing one', () => {
    const err = new AppError(
      ErrorCode.GlassesSessionFailed,
      "The operation couldn't be completed. (MWDATCamera.StreamError error 3.)",
    );

    expect(err.message).toContain('MWDATCamera.StreamError');
    expect(err.userMessage).toBe('Lost the glasses feed. Reconnecting…');
  });

  it('accepts an override for the wearer-facing text', () => {
    const err = new AppError(ErrorCode.WakeWordPermissionDenied, 'denied', {
      userMessage: 'Enable it in iOS Settings → Clypso.',
    });
    expect(err.userMessage).toBe('Enable it in iOS Settings → Clypso.');
  });

  it('retains the cause and context for logs', () => {
    const cause = new Error('EPIPE');
    const err = new AppError(ErrorCode.CaptureStitchFailed, 'stitch died', {
      cause,
      context: { segments: 7 },
    });

    expect(err.cause).toBe(cause);
    expect(err.context).toEqual({ segments: 7 });
  });
});

describe('AppError.from', () => {
  it('wraps a plain Error, keeping its message as the developer detail', () => {
    const wrapped = AppError.from(new Error('ENOENT'), ErrorCode.StorageDeleteFailed);
    expect(wrapped.code).toBe(ErrorCode.StorageDeleteFailed);
    expect(wrapped.message).toBe('ENOENT');
  });

  it('passes an existing AppError through so a specific code is never overwritten', () => {
    const original = new AppError(ErrorCode.CaptureBufferEmpty, 'nothing buffered');
    expect(AppError.from(original, ErrorCode.CaptureStitchFailed)).toBe(original);
  });

  it('handles the non-Error values a catch can actually receive', () => {
    expect(AppError.from('just a string', ErrorCode.Unexpected).message).toBe(
      'just a string',
    );
    expect(AppError.from({ code: 42 }, ErrorCode.Unexpected).message).toBe('{"code":42}');
  });
});

describe('describe', () => {
  it('unwraps the useful one-liner from anything', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('boom')).toBe('boom');
    expect(describeError({ a: 1 })).toBe('{"a":1}');
  });

  it('does not throw on a circular object', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
  });
});

describe('userMessageFor', () => {
  it('uses the typed message when there is one', () => {
    const err = new AppError(ErrorCode.CaptureBufferEmpty, 'internal detail');
    expect(userMessageFor(err)).toBe('Nothing buffered yet — give it a few seconds.');
  });

  it('never leaks a raw native message for an untyped failure', () => {
    const raw = new Error('NSOSStatusErrorDomain Code=-16110');
    expect(userMessageFor(raw)).toBe('Something went wrong. Try again.');
    expect(userMessageFor(raw)).not.toContain('NSOSStatus');
  });

  it('uses the fallback code when one is offered', () => {
    expect(userMessageFor(new Error('raw'), ErrorCode.GlassesUnavailable)).toBe(
      'Glasses not connected.',
    );
  });
});
