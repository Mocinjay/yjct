import type { CaptionStyleKey } from '../captions/captionStyles';

/**
 * PHASE 2 SEAM — interface only.
 *
 * Captioning is external, swappable infra. The contract is the deliverable:
 * clip file in → captioned clip file out. Never hardcode a transcription
 * vendor in the core app.
 */
export interface CaptioningProvider {
  readonly name: string;
  /**
   * False for stand-ins that hand the clip back untouched. The library reads
   * this so a mock run is never badged as really captioned.
   */
  readonly burnsCaptions: boolean;

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
