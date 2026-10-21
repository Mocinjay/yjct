import { FREE_BUFFER_SECONDS_MAX } from '../config';
import { CaptureController, isCaptureLive } from '../core/CaptureController';
import { entitlementStore } from '../core/EntitlementStore';
import { settingsStore } from '../core/SettingsStore';
import { MWDATSource } from '../device/MWDATSource';
import { captionQueue } from '../phase2/CaptionQueue';
import type { Settings } from '../types';
import { MockWakeWord } from '../wakeword/MockWakeWord';
import { SpeechWakeWord } from '../wakeword/SpeechWakeWord';
import type { WakeWordProvider } from '../wakeword/WakeWordProvider';

/**
 * Composition root for a capture session. A fresh controller is built per
 * Armed screen mount, so settings changes (wake word, buffer length, chime)
 * apply to the next session. The source is always the Meta glasses.
 */
export interface CaptureSession {
  controller: CaptureController;
  /** Set when Settings picks "Manual button": the Armed screen's Clip button fires it. */
  mockWakeWord?: MockWakeWord;
}

/**
 * Sessions whose glasses may be recording. Captioning is held while ANY of
 * them is (see CaptionQueue), not by whichever reported last: a screen that is
 * replaced (Library "Go live" resets to a fresh Armed) disarms asynchronously,
 * and its late 'idle' must not release the hold over the new session that is
 * already live.
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

export async function buildCaptureSession(): Promise<CaptureSession> {
  const settings = await settingsStore.get();
  const isPro = await entitlementStore.isPro();
  // Entitlement is enforced here, not just in the settings UI, so a stale
  // stored value can never grant a Pro window to a free user.
  const windowSeconds = isPro
    ? settings.bufferSeconds
    : Math.min(settings.bufferSeconds, FREE_BUFFER_SECONDS_MAX);
  const { wakeWord, mockWakeWord } = buildWakeWord(settings);
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
  return { controller, mockWakeWord };
}

function buildWakeWord(settings: Settings): {
  wakeWord: WakeWordProvider;
  mockWakeWord?: MockWakeWord;
} {
  if (settings.wakeWord.provider === 'speech') {
    return { wakeWord: new SpeechWakeWord() };
  }
  const mockWakeWord = new MockWakeWord();
  return { wakeWord: mockWakeWord, mockWakeWord };
}
