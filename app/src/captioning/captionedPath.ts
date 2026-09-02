/**
 * Where a captioned render of a clip goes.
 *
 * All three providers built this path by hand, with the same reasoning written
 * out three times: the style (and, for the hook-first cut, the fact that it is
 * one) belongs in the filename so re-captioning writes a *new* file. Overwriting
 * one path leaves the player showing the video it has already decoded.
 */
export function captionedPath(clipFilePath: string, suffix: string): string {
  return clipFilePath.replace(/\.mp4$/, `.captioned.${suffix}.mp4`);
}
