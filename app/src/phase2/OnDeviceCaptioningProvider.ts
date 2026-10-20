import {
  climaxEngineAvailable,
  extractFeatures,
  renderEdit,
  transcribeClip,
} from '../native/CaptionEngineNative';
import type { CaptioningProvider } from './CaptioningProvider';
import type { CaptionBurnStyle, CaptionStyleKey } from './captionStyles';
import { DEFAULT_CAPTION_STYLE, captionStylePreset } from './captionStyles';
import type { CaptionCue, TimedWord } from './captionTimeline';
import { buildCaptionCues } from './captionTimeline';
import type { EditSegment } from './climaxEdit';
import { buildClimaxCaptionCues, planSegments } from './climaxEdit';
import { findHook } from './climaxScoring';

/**
 * Captioning — and optionally the climax-first re-cut — entirely on the phone.
 *
 *   transcribe (Speech, on-device)
 *     -> analyse (Accelerate + AVAssetReader)      [climax only]
 *     -> score the rolling windows                 [climax only]
 *     -> plan the edit                             [climax only]
 *     -> map the words onto the output timeline
 *     -> render: restructure and burn in ONE export
 *
 * No server, no API key, no model download, and the wearer's audio stays on
 * the device that recorded it.
 *
 * The restructure and the burn deliberately share a single export. Cutting
 * first and captioning after would cost two encode generations, and captions
 * laid out on the chronological timeline would open the hook mid-phrase.
 */
export class OnDeviceCaptioningProvider implements CaptioningProvider {
  readonly name: string;

  constructor(private readonly climax = false) {
    // The name is recorded on the clip, so the library can tell the wearer
    // which pipeline produced what they are looking at.
    this.name = climax ? 'on-device+hook' : 'on-device';
  }

  async caption(
    clipFilePath: string,
    options?: { style?: CaptionStyleKey },
  ): Promise<{ captionedFilePath: string }> {
    const styleKey = options?.style ?? DEFAULT_CAPTION_STYLE;
    const style = captionStylePreset(styleKey).burn;

    const { words } = await transcribeClip(clipFilePath);
    const { segments, cues } = await planEdit(clipFilePath, words, style, this.climax);

    // The style is part of the filename so restyling writes a new file rather
    // than overwriting one the player may already have decoded.
    const suffix = this.climax ? `hook.${styleKey}` : styleKey;
    const captionedFilePath = clipFilePath.replace(
      /\.mp4$/,
      `.captioned.${suffix}.mp4`,
    );

    // An empty plan means "the whole source, unchanged"; the native side fills
    // in the duration, and copies instead of re-encoding when there is also
    // nothing to draw.
    await renderEdit(clipFilePath, captionedFilePath, segments ?? [], cues, style);
    return { captionedFilePath };
  }
}

/** What `renderEdit` is given: the output timeline and the cues on it. */
export interface EditPlan {
  /** The hook-first timeline, or null for "the whole source, in order". */
  segments: EditSegment[] | null;
  cues: CaptionCue[];
}

/**
 * Lays out the output timeline: hook-first when `climax` is on and the
 * analysis succeeds, chronological otherwise. The captioner and the dev test
 * render (testRender.ts) both go through here, so the test render exercises
 * exactly what ships.
 *
 * Analysis failure is not captioning failure: if the features cannot be
 * extracted the clip still gets captions, chronologically. Losing the hook is
 * worth far less than losing the clip.
 *
 * `report` receives a line per analysis step for the test render's log. The
 * captioner passes none, so those strings are never built in production.
 */
export async function planEdit(
  clipFilePath: string,
  words: TimedWord[],
  style: CaptionBurnStyle,
  climax: boolean,
  report?: (line: string) => void,
): Promise<EditPlan> {
  if (climax && climaxEngineAvailable()) {
    try {
      const grid = await extractFeatures(clipFilePath);
      const signals = Object.keys(grid.signals);
      report?.(
        `Analysed ${grid.duration.toFixed(1)}s: ` +
          `${signals.length} signals (${signals.join(', ')}).`,
      );
      const hook = findHook(grid, words);
      report?.(
        `Hook ${hook.start.toFixed(2)}–${hook.end.toFixed(2)}s ` +
          `score ${hook.score.toFixed(3)} confidence ${hook.confidence.toFixed(3)}.`,
      );
      report?.(
        'Why: ' +
          Object.entries(hook.reason)
            .map(([k, v]) => `${k} ${v.toFixed(2)}`)
            .join(' · '),
      );
      const segments = planSegments({
        hookStart: hook.start,
        hookEnd: hook.end,
        sourceDuration: grid.duration,
      });
      return { segments, cues: buildClimaxCaptionCues(words, segments, style) };
    } catch (err) {
      report?.(
        'Analysis failed, captioning chronologically: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  return { segments: null, cues: buildCaptionCues(words, style) };
}
