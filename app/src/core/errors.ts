/**
 * Typed application errors.
 *
 * Before this, every failure in the app was a bare `Error` whose `message` was
 * whatever the native layer happened to say, and the Armed screen rendered that
 * string straight into its banner. Two things went wrong with that: the wearer
 * saw text like "The operation couldn't be completed. (MWDATCamera.StreamError
 * error 3.)", and nothing in the codebase could ask *what kind* of failure this
 * was without matching on message substrings.
 *
 * An `AppError` carries a stable `code` that callers can branch on, a `cause`
 * that keeps the original failure intact for logs, and a `userMessage` that is
 * safe to put on screen. The raw `message` stays developer-facing.
 */

/**
 * Codes are `domain/slug`. The domain is the subsystem that failed, and it is
 * what the logger tags entries with, so a filter like "everything hardware"
 * needs no separate taxonomy.
 */
export const ErrorCode = {
  // Hardware: the glasses link, the phone camera, the native bridges.
  GlassesUnavailable: 'hardware/glasses-unavailable',
  GlassesSessionFailed: 'hardware/session-failed',
  GlassesStreamStalled: 'hardware/stream-stalled',
  GlassesTeardownFailed: 'hardware/teardown-failed',
  GlassesPreviewFailed: 'hardware/preview-failed',
  CameraStartFailed: 'hardware/camera-start-failed',

  // Wake word: permissions and the recognizer itself.
  WakeWordPermissionDenied: 'wakeword/permission-denied',
  WakeWordStartFailed: 'wakeword/start-failed',
  WakeWordStopFailed: 'wakeword/stop-failed',
  WakeWordTranscribeFailed: 'wakeword/transcribe-failed',

  // Capture: the arm → buffer → stitch → library loop.
  CaptureArmFailed: 'capture/arm-failed',
  CaptureDisarmFailed: 'capture/disarm-failed',
  CaptureBufferEmpty: 'capture/buffer-empty',
  CaptureStitchFailed: 'capture/stitch-failed',
  CaptureSaveFailed: 'capture/save-failed',
  CaptureSegmentCleanupFailed: 'capture/segment-cleanup-failed',

  // Storage: the clip library and its index.
  StorageIndexUnreadable: 'storage/index-unreadable',
  StorageWriteFailed: 'storage/write-failed',
  StorageDeleteFailed: 'storage/delete-failed',
  StorageSweepFailed: 'storage/sweep-failed',

  // Captioning: transcription and burn-in.
  CaptionJobFailed: 'captioning/job-failed',
  CaptionResumeFailed: 'captioning/resume-failed',
  CaptionCleanupFailed: 'captioning/cleanup-failed',

  // Publishing: the connectors and the hosting step they depend on.
  PublishNotConfigured: 'publishing/not-configured',
  PublishAuthFailed: 'publishing/auth-failed',
  PublishUploadFailed: 'publishing/upload-failed',
  PublishRejected: 'publishing/rejected',
  PublishStatusUnknown: 'publishing/status-unknown',
  PublishNetworkFailed: 'publishing/network-failed',
  HostingUploadFailed: 'hosting/upload-failed',
  HostingNotConfigured: 'hosting/not-configured',

  // UI: render-time crashes caught by an error boundary.
  RenderCrash: 'ui/render-crash',
  /** Last resort for a failure that reached a boundary without a code. */
  Unexpected: 'ui/unexpected',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export type ErrorDomain =
  | 'hardware'
  | 'wakeword'
  | 'capture'
  | 'storage'
  | 'captioning'
  | 'publishing'
  | 'hosting'
  | 'ui';

/**
 * What the wearer sees. Deliberately plain, and deliberately about what to do
 * rather than what broke — the phone is usually in a pocket, so the only reason
 * to surface a message at all is to tell someone whether they need to act.
 */
const USER_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.GlassesUnavailable]: 'Glasses not connected.',
  [ErrorCode.GlassesSessionFailed]: 'Lost the glasses feed. Reconnecting…',
  [ErrorCode.GlassesStreamStalled]: 'The glasses feed stalled. Reconnecting…',
  [ErrorCode.GlassesTeardownFailed]: 'Glasses did not shut down cleanly.',
  [ErrorCode.GlassesPreviewFailed]: 'Preview unavailable — capture is unaffected.',
  [ErrorCode.CameraStartFailed]: 'Could not start the camera.',
  [ErrorCode.WakeWordPermissionDenied]:
    'Speech recognition is off. Enable it in Settings to use the wake word.',
  [ErrorCode.WakeWordStartFailed]: 'Voice trigger unavailable — use the Clip button.',
  [ErrorCode.WakeWordStopFailed]: 'Voice trigger did not stop cleanly.',
  [ErrorCode.WakeWordTranscribeFailed]: 'Voice trigger missed a moment.',
  [ErrorCode.CaptureArmFailed]: 'Could not start capture.',
  [ErrorCode.CaptureDisarmFailed]: 'Capture did not stop cleanly.',
  [ErrorCode.CaptureBufferEmpty]: 'Nothing buffered yet — give it a few seconds.',
  [ErrorCode.CaptureStitchFailed]: 'Could not save that clip.',
  [ErrorCode.CaptureSaveFailed]: 'Could not save that clip.',
  [ErrorCode.CaptureSegmentCleanupFailed]: 'Some temporary files were left behind.',
  [ErrorCode.StorageIndexUnreadable]: 'Could not read your library.',
  [ErrorCode.StorageWriteFailed]: 'Could not save to your library.',
  [ErrorCode.StorageDeleteFailed]: 'Could not delete that clip.',
  [ErrorCode.StorageSweepFailed]: 'Could not clean up expired clips.',
  [ErrorCode.CaptionJobFailed]: 'Captioning failed. Tap retry on the clip.',
  [ErrorCode.CaptionResumeFailed]: 'Could not resume captioning.',
  [ErrorCode.CaptionCleanupFailed]: 'Some caption files were left behind.',
  [ErrorCode.PublishNotConfigured]:
    'That platform is not connected yet. Add its credentials in Settings → Connections.',
  [ErrorCode.PublishAuthFailed]:
    'That platform rejected your sign-in. Reconnect it in Settings → Connections.',
  [ErrorCode.PublishUploadFailed]: 'Could not upload the clip. Try again.',
  [ErrorCode.PublishRejected]: 'The platform rejected this clip.',
  [ErrorCode.PublishStatusUnknown]:
    'Could not confirm whether the post went live. Check the app for that platform.',
  [ErrorCode.PublishNetworkFailed]: 'No response from the platform. Check your connection.',
  [ErrorCode.HostingUploadFailed]: 'Could not stage the clip for upload. Try again.',
  [ErrorCode.HostingNotConfigured]:
    'Clip hosting is not set up. Add a presign URL in Settings → Connections.',
  [ErrorCode.RenderCrash]: 'Something went wrong on this screen.',
  [ErrorCode.Unexpected]: 'Something went wrong. Try again.',
};

export interface AppErrorOptions {
  /** The original failure. Kept intact for logs; never shown to the wearer. */
  cause?: unknown;
  /** Structured detail for the log line — ids, paths, counts. */
  context?: Record<string, unknown>;
  /** Overrides the default wearer-facing text for this code. */
  userMessage?: string;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly context?: Record<string, unknown>;
  readonly userMessage: string;
  /**
   * Declared explicitly rather than relying on `Error.cause`: the RN/Hermes
   * target does not consistently carry the ES2022 option through `super()`.
   */
  readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.cause = options.cause;
    this.context = options.context;
    this.userMessage = options.userMessage ?? USER_MESSAGES[code];
    // Restores the prototype chain so `instanceof` survives the ES5 target that
    // Babel emits for Hermes; without it every AppError reads as a plain Error.
    Object.setPrototypeOf(this, AppError.prototype);
  }

  get domain(): ErrorDomain {
    return this.code.split('/')[0] as ErrorDomain;
  }

  /**
   * Wraps whatever a `catch` produced. Already-typed errors pass through so a
   * code assigned deep in the stack is not overwritten by a broader one at the
   * boundary.
   */
  static from(
    error: unknown,
    code: ErrorCode,
    options: AppErrorOptions = {},
  ): AppError {
    if (error instanceof AppError) {
      return error;
    }
    return new AppError(code, describe(error), { ...options, cause: error });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** The developer-facing one-liner for anything a `catch` can hand you. */
export function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * The text to put in front of the wearer. Untyped failures get a generic line
 * rather than a raw native message, which is the whole point of the split.
 */
export function userMessageFor(error: unknown, fallbackCode?: ErrorCode): string {
  if (isAppError(error)) {
    return error.userMessage;
  }
  return fallbackCode
    ? USER_MESSAGES[fallbackCode]
    : 'Something went wrong. Try again.';
}
