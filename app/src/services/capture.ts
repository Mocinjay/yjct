import { FREE_BUFFER_SECONDS_MAX } from '../config';
import { CaptureController, isCaptureLive } from '../core/CaptureController';
import { entitlementStore } from '../core/EntitlementStore';
import { ListeningController } from '../core/ListeningController';
import { settingsStore } from '../core/SettingsStore';
import { MWDATSource } from '../device/MWDATSource';
import { errorText, importLog } from '../markers/importLog';
import type { WakeMarker } from '../markers/markerMatching';
import { markerStore } from '../markers/MarkerStore';
import { captionQueue } from '../phase2/CaptionQueue';
import type { CaptureMode, Settings } from '../types';
import { MockWakeWord } from '../wakeword/MockWakeWord';
import { SpeechWakeWord } from '../wakeword/SpeechWakeWord';
import type { WakeWordProvider } from '../wakeword/WakeWordProvider';

/** What the capture screen drives, in either mode. */
export type SessionController = Pick<
  CaptureController,
  'subscribe' | 'arm' | 'disarm' | 'captureNow' | 'startClip' | 'stopClip' | 'lookBackSeconds'
>;

/**
 * Composition root for a capture session. A fresh session is built per Armed
 * screen mount, so settings changes (mode, wake word, buffer length, chime)
 * apply to the next one.
 */
export interface CaptureSession {
  mode: CaptureMode;
  controller: SessionController;
  /** Set when Settings picks "Manual button": the Armed screen's Clip button fires it. */
  mockWakeWord?: MockWakeWord;
}

/**
 * Live sessions whose glasses may be recording. Captioning is held while ANY
 * of them is (see CaptionQueue), not by whichever reported last: a screen that
 * is replaced (Library "Go live" resets to a fresh Armed) disarms
 * asynchronously, and its late 'idle' must not release the hold over the new
 * session that is already live. Glasses-only sessions record nothing on the
 * phone and do not hold captioning.
 */
const liveControllers = new Set<CaptureController>();
const liveListeners = new Set<(live: boolean) => void>();

/**
 * Whether any capture session's glasses may be recording. An extended
 * recording keeps going while the Library and the Player sit on top of Armed,
 * so screens up there read this too.
 */
export function isAnyCaptureLive(): boolean {
  return liveControllers.size > 0;
}

/** Calls `listener` whenever `isAnyCaptureLive()` changes. */
export function subscribeCaptureLive(listener: (live: boolean) => void): () => void {
  liveListeners.add(listener);
  return () => {
    liveListeners.delete(listener);
  };
}

/** Persists a marker for the full-resolution import, logging a failure. */
async function recordMarker(marker: WakeMarker): Promise<void> {
  try {
    await markerStore.add(marker);
  } catch (err) {
    importLog('could not record marker', { id: marker.id, error: errorText(err) });
    throw err;
  }
}

export async function buildCaptureSession(): Promise<CaptureSession> {
  const settings = await settingsStore.get();
  const isPro = await entitlementStore.isPro();
  // Entitlement is enforced here, not just in the settings UI, so a stale
  // stored value can never grant a Pro window to a free user.
  const windowSeconds = isPro
    ? settings.bufferSeconds
    : Math.min(settings.bufferSeconds, FREE_BUFFER_SECONDS_MAX);

  if (settings.captureMode === 'glasses') {
    let controller: ListeningController | null = null;
    const { wakeWord, mockWakeWord } = buildWakeWord(settings, {
      ownMicrophone: true,
      onListeningError: message => controller?.fail(message),
    });
    controller = new ListeningController(wakeWord, windowSeconds, recordMarker);
    return { mode: 'glasses', controller, mockWakeWord };
  }

  const { wakeWord, mockWakeWord } = buildWakeWord(settings, {});
  const controller = new CaptureController(
    new MWDATSource(),
    wakeWord,
    windowSeconds,
    settings.glassesChime,
    clip => {
      // Fire-and-forget: the clip is already saved, and captioning progress
      // is tracked on the clip itself, so nothing here needs awaiting.
      captionQueue.enqueue(clip.id).catch(() => {});
    },
    settings.fullResolution ? recordMarker : undefined,
  );
  controller.subscribe(status => {
    const wasLive = isAnyCaptureLive();
    if (isCaptureLive(status)) {
      liveControllers.add(controller);
    } else {
      liveControllers.delete(controller);
    }
    const live = isAnyCaptureLive();
    captionQueue.setCaptureActive(live);
    if (live !== wasLive) {
      liveListeners.forEach(listener => listener(live));
    }
  });
  return { mode: 'live', controller, mockWakeWord };
}

function buildWakeWord(
  settings: Settings,
  speechOptions: ConstructorParameters<typeof SpeechWakeWord>[0],
): { wakeWord: WakeWordProvider; mockWakeWord?: MockWakeWord } {
  if (settings.wakeWord.provider === 'speech') {
    return { wakeWord: new SpeechWakeWord(speechOptions) };
  }
  const mockWakeWord = new MockWakeWord();
  return { wakeWord: mockWakeWord, mockWakeWord };
}
