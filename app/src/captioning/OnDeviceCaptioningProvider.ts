import {
  climaxEngineAvailable,
  extractFeatures,
  renderEdit,
  transcribeClip,
} from '../native/CaptionEngineNative';
import type { CaptioningProvider } from './CaptioningProvider';
import type { CaptionStyleKey } from '../captions/captionStyles';
import { DEFAULT_CAPTION_STYLE, captionStylePreset } from '../captions/captionStyles';
import { buildCaptionCues } from '../captions/captionTimeline';
import type { EditSegment } from '../editing/climaxEdit';
import { buildClimaxCaptionCues, planSegments } from '../editing/climaxEdit';
import { findHook } from '../editing/climaxScoring';

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
  readonly burnsCaptions = true;

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
    const { segments, cues } = this.climax
      ? await this.climaxPlan(clipFilePath, words, style)
      : { segments: null as EditSegment[] | null, cues: buildCaptionCues(words, style) };

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

  /**
   * Finds the hook and lays out the output timeline.
   *
   * Analysis failure is not captioning failure: if the features cannot be
   * extracted the clip still gets captions, chronologically. Losing the hook
   * is worth far less than losing the clip.
   */
  private async climaxPlan(
    clipFilePath: string,
    words: Awaited<ReturnType<typeof transcribeClip>>['words'],
    style: ReturnType<typeof captionStylePreset>['burn'],
  ): Promise<{ segments: EditSegment[] | null; cues: ReturnType<typeof buildCaptionCues> }> {
    if (!climaxEngineAvailable()) {
      return { segments: null, cues: buildCaptionCues(words, style) };
    }
    try {
      const grid = await extractFeatures(clipFilePath);
      const hook = findHook(grid, words);
      const segments = planSegments({
        hookStart: hook.start,
        hookEnd: hook.end,
        sourceDuration: grid.duration,
      });
      return {
        segments,
        cues: buildClimaxCaptionCues(words, segments, style),
      };
    } catch {
      return { segments: null, cues: buildCaptionCues(words, style) };
    }
  }
}
