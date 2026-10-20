import type { CaptionStyleKey } from './captionStyles';

/**
 * The captioning seam: clip file in → captioned clip file out.
 *
 * Implementations are OnDeviceCaptioningProvider (iOS), HttpCaptioningProvider
 * (server/captioning, or any service with the same contract) and
 * MockCaptioningProvider (dev builds); `captioner.ts` picks one per job. Never
 * hardcode a transcription vendor in the core app.
 */
export interface CaptioningProvider {
  /**
   * Recorded on the clip as `captionProvider`. The library and player treat
   * 'mock' as "nothing was burned in" and never badge it as captioned.
   */
  readonly name: string;

  /**
   * Burns captions into the given clip and returns the path of the new,
   * captioned clip file. Must not mutate the input file.
   *
   * `style` names one of the looks in captionStyles.ts. A provider that does
   * not know the key must fail rather than substitute another one — the app
   * has already told the wearer which style they are getting.
   */
  caption(
    clipFilePath: string,
    options?: { style?: CaptionStyleKey },
  ): Promise<{ captionedFilePath: string }>;
}
