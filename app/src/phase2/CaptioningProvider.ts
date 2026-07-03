/**
 * PHASE 2 SEAM — interface only. No implementation ships in Phase 1.
 *
 * Captioning is external, swappable infra. The contract is the deliverable:
 * clip file in → captioned clip file out. Never hardcode a transcription
 * vendor in the core app.
 */
export interface CaptioningProvider {
  readonly name: string;

  /**
   * Burns captions into the given clip and returns the path of the new,
   * captioned clip file. Must not mutate the input file.
   */
  caption(clipFilePath: string): Promise<{ captionedFilePath: string }>;
}
